#!/usr/bin/env node
// The gate before phases 2 and 3 (harness #62). It decides the scenarios phase N runs: the
// planned ones that have a phase N, and that no earlier phase ended. A scenario that ended (`pass`,
// `fail` or `infra`) has had its repository deleted or archived by the `act` job that ended it;
// one with fewer phases has nothing to run. A phase-N mint scoped to either has nothing to mint
// for, and fails when the repository is gone, so `gate-N` drops them before their jobs start.
//
// A scenario ended when its repository says so (#24, R2): the `act` job that learns a result
// records it as a topic, `kanon-e2e-passed`, `kanon-e2e-failed` or `kanon-e2e-infra`, before it
// deletes or archives the repository. So this attempt's repository, `e2e-<id>-<run>-<attempt>`,
// gone, archived or carrying a result topic, ended. Only the act token deletes, archives or sets
// a topic. The gate never reads a `kanon-e2e-result-<scenario>` artifact, which code in a
// `kanon` job can plant: one that read as `pass` would drop the scenario's later phases. A
// scenario whose repository records no result, and has a phase N, runs it, and a failure there
// fails its job, as before; so does one whose repository the gate couldn't read, whose own `act`
// job reads it again.
//
//   node runner/gate.mjs   (reads PHASE, SCENARIOS, GH_TOKEN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT;
//                           writes `scenarios=<JSON>` to GITHUB_OUTPUT, and exits 0 whatever it drops)

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { api, notFound } from './lib/gh.mjs';
import { ghProcess } from './lib/proc.mjs';
import { retrying } from './lib/retry.mjs';
import { recordedResult } from './run.mjs';
import { PHASES, SETTINGS } from './sizing.mjs';
import { loadScenario } from './validate.mjs';

/** A scenario's repository name, as e2e.yml's scenario jobs pass `repository-name`. @param {string} id @param {string} runId @param {string} attempt */
export const repositoryName = (id, runId, attempt) => `e2e-${id}-${runId}-${attempt}`;

/** The phases a scenario of the catalogue has. @param {string} id */
export const phasesOf = (id) => loadScenario(join('scenarios', id)).steps.phases.length;

/**
 * What `GET repos/<owner>/<name>` answered for a scenario's repository: the repository, `gone` for
 * a 404, or the problem reading it.
 * @typedef {{ repo: { topics?: string[], archived?: boolean } } | { gone: true } | { problem: string }} Read
 */

/**
 * The scenarios phase `phase` runs, as `plan` planned them; the ones it drops, with why; and the
 * kept ones whose repository it couldn't read.
 * @param {{ phase: number, planned: any[], repositories: Record<string, Read | undefined>, phasesOf: (id: string) => number }} a
 * @returns {{ scenarios: any[], dropped: { id: string, why: string }[], unread: { id: string, why: string }[] }}
 */
export function gate({ phase, planned, repositories, phasesOf: count }) {
  const scenarios = [];
  const dropped = [];
  const unread = [];
  for (const s of planned) {
    const n = count(s.id);
    const read = /** @type {any} */ (repositories[s.id]);
    const recorded = recordedResult(read?.repo?.topics);
    if (n < phase) dropped.push({ id: s.id, why: `it has ${n} phase${n === 1 ? '' : 's'}; there is no phase ${phase}` });
    else if (read?.gone === true) dropped.push({ id: s.id, why: 'it ended in an earlier phase: its repository is gone' });
    else if (recorded) dropped.push({ id: s.id, why: `it ended in an earlier phase: its repository records ${recorded}` });
    else if (read?.repo?.archived === true) dropped.push({ id: s.id, why: 'it ended in an earlier phase: its repository is archived' });
    else {
      scenarios.push(s);
      if (typeof read?.problem === 'string') unread.push({ id: s.id, why: read.problem });
    }
  }
  return { scenarios, dropped, unread };
}

/**
 * Reads each planned scenario's repository that has a phase `phase`, with the workflow's token:
 * every one is public.
 * @param {{ phase: number, planned: any[], run: { id: string, attempt: string }, phasesOf: (id: string) => number }} a
 * @param {{ gh: (args: string[], input?: string) => Promise<any>, sleep: (ms: number) => Promise<void> }} deps
 * @returns {Promise<Record<string, Read>>}
 */
export async function readRepositories({ phase, planned, run, phasesOf: count }, deps) {
  const ctx = { gh: retrying(deps.gh, deps), repository: SETTINGS.harness };
  /** @type {Record<string, Read>} */
  const out = {};
  for (const s of planned) {
    if (count(s.id) < phase) continue;
    try {
      out[s.id] = { repo: (await api(ctx, `repos/${SETTINGS.organisation}/${repositoryName(s.id, run.id, run.attempt)}`)) ?? {} };
    } catch (e) {
      out[s.id] = notFound(e) ? { gone: true } : { problem: /** @type {Error} */ (e).message };
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const phase = Number(env.PHASE);
  if (!Number.isInteger(phase) || phase < 2 || phase > PHASES) throw new Error(`gate.mjs: PHASE is \`${env.PHASE}\`; a gate stands before phase 2 to ${PHASES}`);
  const planned = JSON.parse(env.SCENARIOS || '[]');
  const run = { id: env.GITHUB_RUN_ID ?? '', attempt: env.GITHUB_RUN_ATTEMPT ?? '' };
  const repositories = await readRepositories({ phase, planned, run, phasesOf }, { gh: ghProcess(env), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  const d = gate({ phase, planned, repositories, phasesOf });
  for (const x of d.dropped) console.log(`${x.id}: no phase ${phase}, ${x.why}.`);
  for (const x of d.unread) console.log(`::warning title=gate-${phase}::${x.id} runs phase ${phase}, but its repository couldn't be read (${x.why}); its own \`act\` job reads it again.`);
  console.log(`Phase ${phase} runs ${d.scenarios.length ? d.scenarios.map((s) => s.id).join(', ') : 'no scenario'}.`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `scenarios=${JSON.stringify(d.scenarios)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [
      `## gate-${phase}`,
      '',
      `Phase ${phase} runs ${d.scenarios.length ? d.scenarios.map((s) => `\`${s.id}\``).join(', ') : 'no scenario'}.`,
      ...(d.dropped.length ? ['', '| Scenario | Why it has no phase ' + phase + ' |', '|---|---|', ...d.dropped.map((x) => `| \`${x.id}\` | ${x.why} |`)] : []),
      ...(d.unread.length ? ['', `Runs phase ${phase}, its repository unread: ${d.unread.map((x) => `\`${x.id}\``).join(', ')}.`] : []),
      '',
    ].join('\n'));
  }
}
