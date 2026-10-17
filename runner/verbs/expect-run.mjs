// `expect.run` (Kanon plan 0012 §4.2): holds a run `run.await` kept to its conclusion, and its
// jobs, by name, to theirs. It polls until they hold or its deadline passes.

import { NAME, objects, str } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';
import { met, poll, unmet } from '../lib/poll.mjs';
import { differs, named } from '../lib/state.mjs';

const CONCLUSION = str({ enum: ['success', 'failure', 'cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', 'stale'] });

export default {
  verb: 'expect.run',
  kind: 'read',
  waits: true,
  args: {
    run: str({ required: true, pattern: NAME, ref: 'runs' }),
    conclusion: CONCLUSION,
    jobs: objects({ name: str({ required: true }), conclusion: { ...CONCLUSION, required: true } }),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const id = named(ctx, 'runs', step.run);
    await poll(ctx, step.deadline, async () => {
      const run = await api(ctx, repoPath(ctx, `actions/runs/${id}`));
      const p = [];
      if (step.conclusion !== undefined) p.push(differs('conclusion', step.conclusion, run.conclusion));
      if (step.jobs) {
        const { jobs } = await api(ctx, repoPath(ctx, `actions/runs/${id}/jobs?per_page=100`));
        for (const want of step.jobs) {
          const job = jobs.find((/** @type {any} */ j) => j.name === want.name);
          p.push(job ? differs(`job \`${want.name}\``, want.conclusion, job.conclusion) : `job \`${want.name}\`: not in the run`);
        }
      }
      const problems = p.filter(Boolean);
      return problems.length ? unmet(`run ${id}: ${problems.join('; ')}`) : met();
    });
  },
};
