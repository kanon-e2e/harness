// `deployment.await-approval` (Kanon plan 0012 §4.2, decision 9): waits until a run's job for
// the environment is `waiting`. Then, on a nightly run or a dispatch, it cancels the run; on a
// candidate's run, it files the Owner's approval request in the harness repository and waits for
// the Owner's decision, which it keeps. One deadline covers both waits.

import { WORKFLOW, str } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';
import { deadlineAt, met, poll, unmet } from '../lib/poll.mjs';

export default {
  verb: 'deployment.await-approval',
  kind: 'act',
  waits: true,
  args: {
    environment: str({ required: true, pattern: /^[A-Za-z0-9._-]+$/ }),
    workflow: str({ pattern: WORKFLOW }),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const end = deadlineAt(ctx, step.deadline);
    const runId = await poll(ctx, step.deadline, async () => {
      const { workflow_runs: runs } = await api(ctx, repoPath(ctx, 'actions/runs?status=waiting&per_page=100'));
      for (const r of runs.filter((/** @type {any} */ x) => !step.workflow || String(x.path).endsWith(`/${step.workflow}`))) {
        const pending = await api(ctx, repoPath(ctx, `actions/runs/${r.id}/pending_deployments`));
        if (pending.some((/** @type {any} */ p) => p.environment?.name === step.environment)) return met(r.id);
      }
      return unmet(`no run's job waits on the environment ${step.environment} yet`);
    }, end);
    const record = (/** @type {string} */ decision) => {
      ctx.state.approvals = { ...ctx.state.approvals, [step.environment]: { run: runId, decision } };
    };
    if (ctx.trigger !== 'candidate') {
      await api(ctx, repoPath(ctx, `actions/runs/${runId}/cancel`), { method: 'POST' });
      return record('cancelled');
    }
    const url = `https://github.com/${ctx.repository}/actions/runs/${runId}`;
    const request = await api(ctx, `repos/${ctx.harness}/issues`, {
      method: 'POST',
      body: {
        title: `Approve ${step.environment} for Kanon ${ctx.release} in ${ctx.repository}`,
        body: `The scenario \`${ctx.scenario.id}\` waits on the Owner's approval of the environment \`${step.environment}\`, for Kanon \`${ctx.release}\` (Kanon plan 0012, decision 9).\n\nReview the deployment: ${url}\n\nThe harness closes this issue once the decision is made.`,
      },
    });
    const decision = await poll(ctx, step.deadline, async () => {
      const approvals = await api(ctx, repoPath(ctx, `actions/runs/${runId}/approvals`));
      const found = approvals.find((/** @type {any} */ a) => (a.environments ?? []).some((/** @type {any} */ e) => e.name === step.environment));
      return found ? met(found.state) : unmet(`the Owner hasn't decided on ${step.environment} yet (${url})`);
    }, end);
    await api(ctx, `repos/${ctx.harness}/issues/${request.number}`, { method: 'PATCH', body: { state: 'closed' } });
    record(decision);
  },
};
