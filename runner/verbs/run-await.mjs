// `run.await` (Kanon plan 0012 §4.2): waits for a workflow's run on a given event and commit (a
// branch's head, or a pull request's) to complete, and keeps the run under `name`, or under the
// workflow's file name without `.yml`. It reads its conclusion nowhere: `expect.run` does.
//
// With `actor`, a test App (`author`, `judge` or `releaser`), it keeps only a run that App's event
// started: its `triggering_actor`, else its `actor`, is the App's bot login (E10, harness #104).
// The newest such run, not the newest of all: a lane that labels its own pull request starts more
// runs on the same head, each skipped by its filter in seconds, and none of them is the one the
// scenario's event started. Without `actor`, the newest run of all, as before.

import { readFileSync } from 'node:fs';

import { BRANCH, NAME, WORKFLOW, str } from '../lib/args.mjs';
import { api, botLogin, repoPath } from '../lib/gh.mjs';
import { met, poll, unmet } from '../lib/poll.mjs';
import { commitOf, remember } from '../lib/state.mjs';

/** The test Apps' slugs, by identity (runner/test-apps.json). @type {Record<string, string>} */
const SLUGS = JSON.parse(readFileSync(new URL('../test-apps.json', import.meta.url), 'utf8')).apps;

/** Who started a run: its triggering actor's login, else its actor's. @param {any} r */
const startedBy = (r) => String(r.triggering_actor?.login ?? r.actor?.login ?? '');

/** The name a run is kept under. @param {any} step */
export const runName = (step) => step.name ?? String(step.workflow).replace(/\.ya?ml$/, '');

export default {
  verb: 'run.await',
  kind: 'read',
  waits: true,
  args: {
    name: str({ pattern: NAME }),
    workflow: str({ required: true, pattern: WORKFLOW }),
    event: str({ required: true, pattern: /^[a-z_]+$/ }),
    branch: str({ pattern: BRANCH }),
    pr: str({ pattern: NAME, ref: 'prs' }),
    actor: str({ enum: Object.keys(SLUGS) }),
  },
  check: (/** @type {any} */ step) => ((step.branch === undefined) === (step.pr === undefined) ? ['name the commit by exactly one of `branch` and `pr`'] : []),
  defines: (/** @type {any} */ step) => [['runs', runName(step)]],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const sha = await commitOf(ctx, step);
    const path = repoPath(ctx, `actions/workflows/${step.workflow}/runs?event=${step.event}&head_sha=${sha}&per_page=20`);
    const run = await poll(ctx, step.deadline, async () => {
      const all = (await api(ctx, path)).workflow_runs ?? [];
      const login = step.actor ? botLogin(SLUGS[step.actor]) : null;
      const runs = login ? all.filter((/** @type {any} */ r) => startedBy(r) === login) : all;
      const latest = runs.reduce((/** @type {any} */ a, /** @type {any} */ r) => (!a || r.run_number > a.run_number ? r : a), null);
      if (!latest) return unmet(`no run of ${step.workflow} on ${step.event} for ${sha}${login ? ` started by ${login}` : ''} yet${login && all.length ? `; ${all.length} started by others: ${[...new Set(all.map(startedBy))].join(', ')}` : ''}`);
      return latest.status === 'completed' ? met(latest) : unmet(`run ${latest.id} of ${step.workflow} is ${latest.status}`);
    });
    remember(ctx, 'runs', runName(step), run.id);
  },
};
