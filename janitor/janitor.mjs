#!/usr/bin/env node
// The janitor (Kanon plan 0012 §5.3; harness #16), hourly. It deletes each repository of the test
// organisation that carries the `kanon-e2e` topic and is older than the cut-off, or, with the
// `kanon-e2e-failed` topic, older than the failed cut-off; archived or not. It never deletes a
// repository without the topic, nor the harness. Both cut-offs follow the run's sizing
// (runner/sizing.mjs): the longest a run can keep a repository, plus the margin, and 24 hours
// beyond that for a failed one (decision 13). A repository older than a day that it couldn't
// delete fails its run, by name.
//
//   node janitor/janitor.mjs   (reads GH_TOKEN; writes the step summary; exits 1 on such a repository)

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { GhError, api, goneFrom } from '../runner/lib/gh.mjs';
import { ghProcess } from '../runner/lib/proc.mjs';
import { retrying } from '../runner/lib/retry.mjs';
import { hours, janitorCutoffs, SETTINGS } from '../runner/sizing.mjs';

export const CUTOFFS = Object.freeze(janitorCutoffs());
const TOPIC = 'kanon-e2e';
const FAILED = 'kanon-e2e-failed';
const DAY_MINUTES = 24 * 60;

/**
 * One sweep of the organisation.
 * @param {{ now: number }} at
 * @param {{ gh: (args: string[], input?: string) => Promise<any> }} deps
 */
export async function sweep({ now }, deps) {
  const ctx = { gh: deps.gh, repository: SETTINGS.harness };
  const harness = SETTINGS.harness.split('/')[1];
  const repos = await api(ctx, `orgs/${SETTINGS.organisation}/repos?per_page=100&type=all`, { paginate: true });
  /** @type {Array<{ name: string, ageMinutes: number, failed: boolean }>} */
  const deleted = [];
  /** @type {Array<{ name: string, ageMinutes: number, dueInMinutes: number, failed: boolean }>} */
  const left = [];
  /** @type {Array<{ name: string, ageMinutes: number, why: string }>} */
  const failed = [];
  for (const r of repos) {
    const topics = r.topics ?? [];
    if (r.name === harness || !topics.includes(TOPIC)) continue;
    const ageMinutes = Math.floor((now - Date.parse(r.created_at)) / 60_000);
    const isFailed = topics.includes(FAILED);
    const cutoff = isFailed ? CUTOFFS.failedCutoffMinutes : CUTOFFS.cutoffMinutes;
    if (ageMinutes <= cutoff) {
      left.push({ name: r.name, ageMinutes, dueInMinutes: cutoff - ageMinutes, failed: isFailed });
      continue;
    }
    try {
      // A DELETE GitHub failed is asked again only when the repository is still there (#130).
      const path = `repos/${SETTINGS.organisation}/${r.name}`;
      await api(ctx, path, { method: 'DELETE', landed: goneFrom(ctx, path) });
      deleted.push({ name: r.name, ageMinutes, failed: isFailed });
    } catch (e) {
      if (e instanceof GhError && /\bHTTP 404\b/.test(String(e.stderr))) continue;
      if (ageMinutes > DAY_MINUTES) failed.push({ name: r.name, ageMinutes, why: /** @type {Error} */ (e).message });
    }
  }
  return { ok: failed.length === 0, deleted, left, failed };
}

/** The step summary. @param {Awaited<ReturnType<typeof sweep>>} s */
export const summary = (s) => [
  '## The janitor',
  '',
  `Cut-off ${hours(CUTOFFS.cutoffMinutes)}; with \`${FAILED}\`, ${hours(CUTOFFS.failedCutoffMinutes)} (runner/sizing.mjs).`,
  '',
  `### Deleted (${s.deleted.length})`,
  ...s.deleted.map((d) => `- \`${d.name}\`, ${hours(d.ageMinutes)} old${d.failed ? ', failed' : ''}`),
  '',
  `### Left (${s.left.length})`,
  ...s.left.map((d) => `- \`${d.name}\`, ${hours(d.ageMinutes)} old${d.failed ? ', failed' : ''}; due in ${hours(d.dueInMinutes)}`),
  ...(s.failed.length ? ['', `### Could not delete (${s.failed.length}): this run fails`, ...s.failed.map((d) => `- \`${d.name}\`, ${hours(d.ageMinutes)} old: ${d.why}`)] : []),
  '',
].join('\n');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
  const s = await sweep({ now: Date.now() }, { gh: retrying(ghProcess(process.env), { sleep }) });
  const text = summary(s);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  for (const f of s.failed) console.log(`::error title=janitor::could not delete ${f.name}, ${hours(f.ageMinutes)} old: ${f.why}`);
  process.exitCode = s.ok ? 0 : 1;
}
