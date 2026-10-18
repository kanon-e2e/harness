#!/usr/bin/env node
// `verdict` (Kanon plan 0012 §5.2; harness #16, as far as E4 builds it): reads each scenario's
// `kanon-e2e-result/v1` and gives the run's verdict, `kanon-e2e-verdict/v1`:
//
//   pass        every planned scenario read `pass`;
//   fail        any scenario read `fail`;
//   infra-only  nothing failed, but a scenario read `infra` or left no result, or `start` failed,
//               so the Reporter couldn't post. Never `pass`.
//
// It exits 0 on `pass` and 1 otherwise, after writing verdict.json, so the job's colour is the
// verdict's. Reading `gate: true` for the candidate's gate, and the issues it files, are E8's.
//
//   node runner/verdict.mjs   (reads START_RESULT, SCENARIOS, RESULTS_DIR; writes OUT/verdict.json)

import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERDICT_SCHEMA = 'kanon-e2e-verdict/v1';
const RESULT_SCHEMA = 'kanon-e2e-result/v1';
const PREFIX = 'kanon-e2e-result-';

/**
 * The run's verdict.
 * @param {{ planned: string[], results: any[], startResult: string }} input
 */
export function judge({ planned, results, startResult }) {
  const byId = new Map(results.filter((r) => r?.schema === RESULT_SCHEMA && ['pass', 'fail', 'infra'].includes(r.result)).map((r) => [r.scenario, r]));
  const scenarios = planned.map((id) => ({ id, result: byId.get(id)?.result ?? 'missing' }));
  const failed = scenarios.filter((s) => s.result === 'fail');
  const short = scenarios.filter((s) => s.result !== 'pass');
  let verdict;
  let reason;
  if (failed.length) {
    verdict = 'fail';
    reason = `failed: ${failed.map((s) => s.id).join(', ')}`;
  } else if (startResult === 'failure') {
    verdict = 'infra-only';
    reason = '`start` failed: the Reporter could not post the check run, so no scenario ran';
  } else if (short.length || !planned.length) {
    verdict = 'infra-only';
    reason = short.length ? `no failure, but no pass for: ${short.map((s) => `${s.id} (${s.result})`).join(', ')}` : 'no scenario was planned';
  } else {
    verdict = 'pass';
    reason = `all ${planned.length} scenario(s) passed`;
  }
  return { schema: VERDICT_SCHEMA, verdict, reason, scenarios };
}

/** Each result under `dir`, one artifact directory each, as `download-artifact` lays them. @param {string} dir */
const readResults = (dir) => {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(PREFIX) && lstatSync(join(dir, n)).isDirectory()).flatMap((n) => {
    try {
      const r = JSON.parse(readFileSync(join(dir, n, 'result.json'), 'utf8'));
      return r?.scenario === n.slice(PREFIX.length) ? [r] : [];
    } catch {
      return [];
    }
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const planned = JSON.parse(env.SCENARIOS || '[]').map((/** @type {any} */ s) => s.id);
  const v = judge({ planned, results: readResults(env.RESULTS_DIR ?? 'results'), startResult: env.START_RESULT ?? '' });
  const out = env.OUT ?? 'verdict';
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'verdict.json'), `${JSON.stringify(v, null, 2)}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [`## Verdict: **${v.verdict}**`, '', v.reason, '', '| Scenario | Result |', '|---|---|', ...v.scenarios.map((s) => `| \`${s.id}\` | ${s.result} |`), ''].join('\n'));
  }
  console.log(`${v.verdict}: ${v.reason}`);
  process.exitCode = v.verdict === 'pass' ? 0 : 1;
}
