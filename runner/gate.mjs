#!/usr/bin/env node
// The gate before phases 2 and 3 (harness #62). It decides the scenarios phase N runs: the
// planned ones that have a phase N, and that no earlier phase ended. A scenario that ended (`pass`,
// `fail` or `infra`) has had its repository deleted or archived by the `act` job that ended it;
// one with fewer phases has nothing to run. A phase-N mint scoped to either has nothing to mint
// for, and fails when the repository is gone, so `gate-N` drops them before their jobs start.
//
// A scenario ended when its `kanon-e2e-result-<scenario>` names this attempt's repository: a
// result of an earlier attempt, or of another scenario, ends nothing. A scenario with no result
// that has a phase N runs it, and a failure there fails its job, as before.
//
//   node runner/gate.mjs   (reads PHASE, SCENARIOS, RESULTS_DIR, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT;
//                           writes `scenarios=<JSON>` to GITHUB_OUTPUT, and exits 0 whatever it drops)

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RESULT_SCHEMA } from './run.mjs';
import { PHASES, SETTINGS } from './sizing.mjs';
import { loadScenario } from './validate.mjs';
import { readResults } from './verdict.mjs';

/** A scenario's repository name, as e2e.yml's scenario jobs pass `repository-name`. @param {string} id @param {string} runId @param {string} attempt */
export const repositoryName = (id, runId, attempt) => `e2e-${id}-${runId}-${attempt}`;

/** The phases a scenario of the catalogue has. @param {string} id */
export const phasesOf = (id) => loadScenario(join('scenarios', id)).steps.phases.length;

/**
 * The scenarios phase `phase` runs, as `plan` planned them, and the ones it drops, with why.
 * @param {{ phase: number, planned: any[], results: any[], run: { id: string, attempt: string }, phasesOf: (id: string) => number }} a
 * @returns {{ scenarios: any[], dropped: { id: string, why: string }[] }}
 */
export function gate({ phase, planned, results, run, phasesOf: count }) {
  const scenarios = [];
  const dropped = [];
  for (const s of planned) {
    const n = count(s.id);
    const repository = `${SETTINGS.organisation}/${repositoryName(s.id, run.id, run.attempt)}`;
    const ended = results.find((r) => r && typeof r === 'object' && r.schema === RESULT_SCHEMA && r.scenario === s.id && r.repository === repository);
    if (n < phase) dropped.push({ id: s.id, why: `it has ${n} phase${n === 1 ? '' : 's'}; there is no phase ${phase}` });
    else if (ended) dropped.push({ id: s.id, why: `it ended in an earlier phase: it reads ${ended.result}` });
    else scenarios.push(s);
  }
  return { scenarios, dropped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const phase = Number(env.PHASE);
  if (!Number.isInteger(phase) || phase < 2 || phase > PHASES) throw new Error(`gate.mjs: PHASE is \`${env.PHASE}\`; a gate stands before phase 2 to ${PHASES}`);
  const planned = JSON.parse(env.SCENARIOS || '[]');
  const run = { id: env.GITHUB_RUN_ID ?? '', attempt: env.GITHUB_RUN_ATTEMPT ?? '' };
  const d = gate({ phase, planned, results: readResults(env.RESULTS_DIR ?? 'results'), run, phasesOf });
  for (const x of d.dropped) console.log(`${x.id}: no phase ${phase}, ${x.why}.`);
  console.log(`Phase ${phase} runs ${d.scenarios.length ? d.scenarios.map((s) => s.id).join(', ') : 'no scenario'}.`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `scenarios=${JSON.stringify(d.scenarios)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [
      `## gate-${phase}`,
      '',
      `Phase ${phase} runs ${d.scenarios.length ? d.scenarios.map((s) => `\`${s.id}\``).join(', ') : 'no scenario'}.`,
      ...(d.dropped.length ? ['', '| Scenario | Why it has no phase ' + phase + ' |', '|---|---|', ...d.dropped.map((x) => `| \`${x.id}\` | ${x.why} |`)] : []),
      '',
    ].join('\n'));
  }
}
