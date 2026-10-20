// `deployment.await-approval` (Kanon plan 0012 §4.2, decision 9 as amended on 2026-10-20): waits
// until a run's job for the environment is `waiting`, cancels the run, and waits for that job to
// end, which must be `cancelled`. Every trigger does the same, a candidate's run included: no
// person is asked anything. It keeps the run, the decision and the waiting jobs' names. One
// deadline covers every wait.

import { WORKFLOW, str } from '../lib/args.mjs';
import { Fail } from '../lib/fail.mjs';
import { api, repoPath } from '../lib/gh.mjs';
import { deadlineAt, met, poll, unmet } from '../lib/poll.mjs';

/** A run's jobs. @param {any} ctx @param {number} runId */
const jobsOf = async (ctx, runId) => (await api(ctx, repoPath(ctx, `actions/runs/${runId}/jobs?per_page=100`))).jobs ?? [];

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
    const { runId, waiting } = await poll(ctx, step.deadline, async () => {
      const { workflow_runs: runs } = await api(ctx, repoPath(ctx, 'actions/runs?status=waiting&per_page=100'));
      for (const r of runs.filter((/** @type {any} */ x) => !step.workflow || String(x.path).endsWith(`/${step.workflow}`))) {
        const pending = await api(ctx, repoPath(ctx, `actions/runs/${r.id}/pending_deployments`));
        if (!pending.some((/** @type {any} */ p) => p.environment?.name === step.environment)) continue;
        const jobs = (await jobsOf(ctx, r.id)).filter((/** @type {any} */ j) => j.status === 'waiting');
        if (jobs.length) return met({ runId: r.id, waiting: jobs });
      }
      return unmet(`no run's job waits on the environment ${step.environment} yet`);
    }, end);
    await api(ctx, repoPath(ctx, `actions/runs/${runId}/cancel`), { method: 'POST' });
    const ended = await poll(ctx, step.deadline, async () => {
      const jobs = (await jobsOf(ctx, runId)).filter((/** @type {any} */ j) => waiting.some((/** @type {any} */ w) => w.id === j.id));
      const open = jobs.filter((/** @type {any} */ j) => j.status !== 'completed');
      return open.length ? unmet(`${open.map((/** @type {any} */ j) => `\`${j.name}\``).join(', ')} of run ${runId} hasn't ended since the cancel`) : met(jobs);
    }, end);
    const wrong = ended.filter((/** @type {any} */ j) => j.conclusion !== 'cancelled');
    if (wrong.length) throw new Fail(`run ${runId} was cancelled at ${step.environment}'s wait, and ${wrong.map((/** @type {any} */ j) => `\`${j.name}\` ended \`${j.conclusion}\``).join(', ')}, not \`cancelled\``);
    ctx.state.approvals = { ...ctx.state.approvals, [step.environment]: { run: runId, decision: 'cancelled', jobs: waiting.map((/** @type {any} */ j) => j.name) } };
  },
};
