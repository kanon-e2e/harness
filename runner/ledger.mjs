// The real-model ledger (Kanon plan 0012 §6.2, decision 7 as changed; step E10). `plan` asks it,
// before any repository is created, which of the run's real-model scenarios (`claude:
// subscription`) may start. It holds the run's $2 softly:
//
//   - a scenario's EXPECTED COST is the largest cost its last ten recorded runs reported, times
//     the margin, 1.5. The costs are read from the scenario's own `kanon-e2e-result/v1` documents,
//     their `costUsd`, which `expect.row` keeps from the lane's telemetry row (the run's
//     `total_cost_usd`, Claude Code's own reckoning: on the subscription token a figure, not a bill);
//   - it adds that to what the run's earlier admitted scenarios are expected to spend, and refuses
//     the scenario when the sum could pass the cap: `skipped: budget`. The admitted scenarios run
//     at once, so "already spent" at `plan` is the sum of their expected costs;
//   - A SCENARIO WITH NO RECORDED COST runs only by a dispatch, and only alone: never on the poll,
//     the nightly or a candidate's poll, and never beside another real-model scenario. Its first
//     run is the Owner's, with nothing else against the cap;
//   - at most `maxModelScenarios` (decision 15) start in one run.
//
// A GATING SCENARIO IS NEVER REFUSED IN SILENCE (#107). The `gate: true` scenarios are admitted
// before the others, so a `gate: false` one earlier in the catalogue never takes a gating one's
// place under the cap or the two. One still refused carries a `skipped` word whatever the reason
// (`budget`, `no-history`, `max-model`), so `plan` hands it to `verdict`, which reads it as `fail`
// on a candidate's run. A `gate: false` one refused for no history or for the two carries none.
//
// It is soft: a run that goes past its own history can still spend up to its lane's ceiling ($30
// for the Reviewer) before the ledger sees it. The lane's `--max-budget-usd` is the hard bound on
// one run; the subscription's usage limits are the month's.
//
// A RESULT IS EVIDENCE, NOT PROOF (harness #24): a `kanon` job's code can upload a result under any
// scenario's name in its own run. A planted low `costUsd` would make the ledger expect less. The
// lane's own ceiling still holds each run.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { api, GhError } from './lib/gh.mjs';
import { SETTINGS } from './sizing.mjs';

const H = `repos/${SETTINGS.harness}`;
const RESULT_SCHEMA = 'kanon-e2e-result/v1';

/** Whether a scenario uses the real model, as `plan`'s `model-scenarios` reads it. @param {{ claude?: string, tier?: string }} s */
export const isModel = (s) => s.claude === 'subscription' || s.tier === 'model';

/**
 * A scenario's expected cost: the largest of its last `historyRuns` recorded costs, times the
 * margin. Null when it has none.
 * @param {number[]} costs newest first @param {typeof SETTINGS.ledger} [l]
 */
export const expectedCost = (costs, l = SETTINGS.ledger) => {
  const last = costs.slice(0, l.historyRuns);
  return last.length ? Math.max(...last) * l.margin : null;
};

/** Dollars, for a reason. @param {number} usd */
const usd = (usd) => `$${usd.toFixed(2)}`;

/**
 * @typedef {{ id: string, gate?: boolean }} Entry
 * @typedef {{ id: string, gate: boolean, skipped: string | null, reason: string }} Refusal
 * @typedef {{ id: string, expectedUsd: number | null, reason: string }} Admission
 */

/**
 * Which real-model scenarios start: the gating ones first, then the others, each in catalogue order.
 * @param {{ kind: 'poll' | 'nightly' | 'dispatch', models: Entry[], history: Record<string, number[]> }} input
 *   `history` holds each scenario's recorded costs, newest first
 * @param {typeof SETTINGS} [s]
 * @returns {{ admitted: Admission[], refused: Refusal[], expectedUsd: number }}
 */
export function admit({ kind, models, history }, s = SETTINGS) {
  const cap = s.ledger.capUsd;
  /** @type {Admission[]} */
  const admitted = [];
  /** @type {Refusal[]} */
  const refused = [];
  let sum = 0;
  const refuse = (/** @type {Entry} */ m, /** @type {string | null} */ skipped, /** @type {string} */ reason) => refused.push({ id: m.id, gate: m.gate === true, skipped, reason });
  // A gating scenario's refusal always reaches `verdict` (#107); a `gate: false` one's only for its cost.
  const hold = (/** @type {Entry} */ m, /** @type {string} */ skipped, /** @type {string} */ reason) => (m.gate === true
    ? refuse(m, skipped, `${reason}; it gates, so \`verdict\` reads it as \`skipped: ${skipped}\``)
    : refuse(m, null, reason));
  for (const m of [...models.filter((x) => x.gate === true), ...models.filter((x) => x.gate !== true)]) {
    const expected = expectedCost(history[m.id] ?? [], s.ledger);
    if (expected === null) {
      // No recorded cost: the Owner's dispatch, alone (§6.2).
      if (kind !== 'dispatch') hold(m, 'no-history', `not started: no recorded cost yet, so its first run is a dispatch the Owner starts, alone (Kanon plan 0012 §6.2); a ${kind} never starts it`);
      else if (models.length > 1) hold(m, 'no-history', `not started: no recorded cost yet, so its first run is dispatched alone, with no other real-model scenario against the $${cap} cap; this dispatch selects ${models.length}`);
      else admitted.push({ id: m.id, expectedUsd: null, reason: `started: its first run, dispatched alone, with no recorded cost to expect from` });
      continue;
    }
    if (admitted.length >= s.maxModelScenarios) {
      hold(m, 'max-model', `not started: at most ${s.maxModelScenarios} real-model scenarios a run (decision 15)`);
      continue;
    }
    if (sum + expected > cap) {
      refuse(m, 'budget', `skipped: budget. Expected ${usd(expected)} (the largest of its last ${Math.min((history[m.id] ?? []).length, s.ledger.historyRuns)} recorded costs, ${usd(expected / s.ledger.margin)}, times ${s.ledger.margin}), and the run's admitted scenarios already expect ${usd(sum)}: together past the run's ${usd(cap)}`);
      continue;
    }
    sum += expected;
    admitted.push({ id: m.id, expectedUsd: expected, reason: `started: expected ${usd(expected)}, ${usd(sum)} of the run's ${usd(cap)}` });
  }
  return { admitted, refused, expectedUsd: sum };
}

/**
 * An artifact's one JSON file, or null when it holds none that parses. A failed download throws.
 * @param {import('./lib/gh.mjs').GhContext} ctx @param {number} runId @param {string} name @param {string} file
 */
export const downloadJson = async (ctx, runId, name, file) => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  try {
    const r = await ctx.gh(['run', 'download', String(runId), '-R', SETTINGS.harness, '-n', name, '-D', dir]);
    if (r.status !== 0) throw new GhError(`run download ${runId} -n ${name}`, r);
    try {
      return JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      return null;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * A scenario's recorded costs, newest first, at most `historyRuns`: from the `costUsd` of its
 * `kanon-e2e-result-<scenario>` artifacts on runs of `main`, unexpired. A result with no cost (the
 * scenario ended before its lane's row was read) is no history.
 * @param {import('./lib/gh.mjs').GhContext} ctx @param {string} id
 * @param {{ download?: typeof downloadJson }} [deps]
 */
export async function recordedCosts(ctx, id, { download = downloadJson } = {}) {
  const name = `kanon-e2e-result-${id}`;
  const pages = await api(ctx, `${H}/actions/artifacts?name=${name}&per_page=100`, { paginate: true });
  const list = pages.flatMap((/** @type {any} */ p) => p.artifacts ?? [])
    .filter((/** @type {any} */ a) => a.name === name && !a.expired && a.workflow_run?.head_branch === 'main')
    .sort((/** @type {any} */ a, /** @type {any} */ b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  /** @type {number[]} */
  const costs = [];
  for (const a of list) {
    if (costs.length >= SETTINGS.ledger.historyRuns) break;
    const r = await download(ctx, Number(a.workflow_run.id), name, 'result.json');
    if (r?.schema === RESULT_SCHEMA && r.scenario === id && typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0) costs.push(r.costUsd);
  }
  return costs;
}
