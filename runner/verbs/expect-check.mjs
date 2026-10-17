// `expect.check` (Kanon plan 0012 §4.2): holds a commit's check run, or else its commit status,
// of a name to a conclusion (a status's state). The commit is a branch's head or a pull
// request's. It polls until it holds or its deadline passes.

import { BRANCH, NAME, str } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';
import { met, poll, unmet } from '../lib/poll.mjs';
import { commitOf, differs } from '../lib/state.mjs';

export default {
  verb: 'expect.check',
  kind: 'read',
  waits: true,
  args: {
    branch: str({ pattern: BRANCH }),
    pr: str({ pattern: NAME, ref: 'prs' }),
    name: str({ required: true }),
    conclusion: str({ required: true, enum: ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'error', 'pending'] }),
  },
  check: (/** @type {any} */ step) => ((step.branch === undefined) === (step.pr === undefined) ? ['name the commit by exactly one of `branch` and `pr`'] : []),
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const sha = await commitOf(ctx, step);
    await poll(ctx, step.deadline, async () => {
      const { check_runs: runs } = await api(ctx, repoPath(ctx, `commits/${sha}/check-runs?check_name=${encodeURIComponent(step.name)}&per_page=100`));
      let read;
      if (runs.length) {
        const latest = runs.reduce((/** @type {any} */ a, /** @type {any} */ r) => (r.id > a.id ? r : a));
        read = latest.status === 'completed' ? latest.conclusion : latest.status;
      } else {
        const { statuses } = await api(ctx, repoPath(ctx, `commits/${sha}/status`));
        read = statuses.find((/** @type {any} */ s) => s.context === step.name)?.state ?? null;
      }
      const problem = read === null ? `\`${step.name}\`: no check run or status on ${sha}` : differs(`\`${step.name}\``, step.conclusion, read);
      return problem ? unmet(problem) : met();
    });
  },
};
