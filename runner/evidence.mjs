// What only an `act` job can write (harness #24, R3; the Owner, 2026-10-19). Code in a `kanon`
// job, Kanon's release under test and what it pulls in from npm, can probably upload an artifact
// under any name in the run, so a `kanon-e2e-result-<scenario>` reading `pass` can be planted.
// The run's jobs list can't be: GitHub writes it, the job and step names come from this
// repository's workflows at the run's commit, and an `act` job runs no Kanon code.
//
// So the `act` job that finalizes a scenario runs one step whose name is the result,
// `The scenario reads <result>` (e2e-act-job.yml), and skips the other two; a job that didn't
// finalize it skips all three. A scenario's result is the one its first `act` job to finalize it
// recorded, since a result is set once. A `pass` counts only when that job is the scenario's last
// `act` job that ran, and concluded `success`: its result upload, among the rest, succeeded.
//
// `verdict` and `burn-in` read it. Both repositories are public; a token is used only because
// `verdict` has one, with `actions: read`.

import { api } from './lib/gh.mjs';
import { PHASES, SETTINGS } from './sizing.mjs';

const RESULTS = /** @type {const} */ (['pass', 'fail', 'infra']);

/** The step an `act` job runs for the result it finalized the scenario with. */
export const RESULT_STEPS = Object.freeze(Object.fromEntries(RESULTS.map((r) => [r, `The scenario reads ${r}`])));

/**
 * The `act` job of phase `phase` for scenario `id`, as the jobs list names a called workflow's
 * job: `e2e.yml`'s `act-<n> (<id>)`, then `e2e-act-run.yml`'s `job`, then `e2e-act-job.yml`'s.
 * @param {number} phase @param {string} id
 */
export const actJob = (phase, id) => `act-${phase} (${id}) / job / act segment`;

/**
 * Every job of a run's attempt, from every page.
 * @param {import('./lib/gh.mjs').GhContext} ctx @param {string | number} runId @param {string | number} attempt
 * @returns {Promise<any[]>}
 */
export const readJobs = async (ctx, runId, attempt) => {
  const pages = await api(ctx, `repos/${SETTINGS.harness}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, { paginate: true });
  return (pages ?? []).flatMap((/** @type {any} */ p) => (Array.isArray(p?.jobs) ? p.jobs : []));
};

/**
 * Scenario `id`'s result as the jobs list records it:
 *   `pass`, `fail` or `infra`, with the phase whose `act` job recorded it;
 *   `unconfirmed`, with why, for a `pass` R3 holds back, or a job that recorded two results;
 *   null, with why, when no `act` job of it recorded one. `legacy` is then whether its `act`
 *   jobs ran from a workflow without the result steps, from before #24's fix.
 * @param {any[]} jobs @param {string} id
 * @returns {{ result: 'pass' | 'fail' | 'infra' | 'unconfirmed' | null, phase?: number, why?: string, legacy?: boolean }}
 */
export function attested(jobs, id) {
  /** @type {Array<{ phase: number, job: any }>} */
  const ran = [];
  for (let phase = 1; phase <= PHASES; phase++) {
    const job = jobs.find((j) => j?.name === actJob(phase, id));
    if (job && job.conclusion !== 'skipped') ran.push({ phase, job });
  }
  const steps = (/** @type {any} */ job) => (Array.isArray(job.steps) ? job.steps : []);
  const recorded = (/** @type {any} */ job) => RESULTS.filter((r) => steps(job).some((/** @type {any} */ s) => s?.name === RESULT_STEPS[r] && s.conclusion === 'success'));
  const first = ran.find((x) => recorded(x.job).length);
  if (!first) {
    const names = Object.values(RESULT_STEPS);
    return {
      result: null,
      why: ran.length ? `no \`act\` job of it recorded a result` : `no \`act\` job of it ran`,
      legacy: ran.length > 0 && !ran.some((x) => steps(x.job).some((/** @type {any} */ s) => names.includes(s?.name))),
    };
  }
  const [result, ...more] = recorded(first.job);
  const job = `act-${first.phase}`;
  if (more.length) return { result: 'unconfirmed', phase: first.phase, why: `${job} recorded more than one result` };
  if (result === 'pass') {
    const last = /** @type {{ phase: number }} */ (ran.at(-1));
    if (last.phase !== first.phase) return { result: 'unconfirmed', phase: first.phase, why: `act-${last.phase} ran after ${job} recorded pass` };
    if (first.job.conclusion !== 'success') return { result: 'unconfirmed', phase: first.phase, why: `${job} recorded pass but concluded ${first.job.conclusion ?? 'nothing'}` };
  }
  return { result, phase: first.phase };
}
