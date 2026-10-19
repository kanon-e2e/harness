#!/usr/bin/env node
// `burn-in` (Kanon plan 0012 §10, step E9; harness #43): a scenario's run of passes, the evidence
// its `gate: true` pull request holds. By the Owner's rule of 2026-10-18, it takes the runs of
// `e2e.yml` on `main`, oldest first, from the scenario's last change to its `steps.json` or
// `start/`:
//
//   a run that planned the scenario against a candidate, or against the latest stable release
//     when it started, counts one more pass if the scenario read `pass`, and breaks the run of
//     passes on anything else (`fail`, `infra`, `skipped`, no result, one it can't read);
//   a run whose `plan` stopped (it gave way, was held, or another run was in flight) recorded no
//     marker, and neither counts nor breaks; nor does a run that didn't plan the scenario, one
//     against an older stable release, or one whose commit is before the change.
//
// It reads the runs' markers and results from their artifacts, and Kanon's public releases. It
// writes nothing but a scratch directory it removes, and holds no key: it needs a token only
// because an artifact's download answers 401 without one.
//
//   node runner/burn-in.mjs <scenario>   (reads GH_TOKEN, or gh's own login; prints the table,
//                                         and exits 0 at ten passes in a row or more, else 1)

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { api, GhError } from './lib/gh.mjs';
import { RELEASE } from './lib/kanon.mjs';
import { ghProcess } from './lib/proc.mjs';
import { CANDIDATE, MARKER, newer, STABLE } from './plan.mjs';
import { SETTINGS } from './sizing.mjs';

/** The passes in a row that earn a scenario `gate: true` (§10). */
export const BURN_IN = 10;

const H = `repos/${SETTINGS.harness}`;
const K = `repos/${SETTINGS.kanon}`;
const WORKFLOW = '.github/workflows/e2e.yml';
const RESULTS = ['pass', 'fail', 'infra', 'skipped'];

/** @typedef {{ run: number, url: string, startedAt: string, trigger: string, release: string, result: string, pass: boolean }} Row */

/**
 * An artifact's one JSON file, or null when it holds none that parses. A failed download throws.
 * @param {import('./lib/gh.mjs').GhContext} ctx @param {number} runId @param {string} name @param {string} file
 */
const download = async (ctx, runId, name, file) => {
  const dir = mkdtempSync(join(tmpdir(), 'burn-in-'));
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
 * The scenario's runs that count or break, oldest first, and its run of passes.
 * @param {string} scenario
 * @param {{ gh: (args: string[], input?: string) => Promise<any> }} deps
 */
export async function count(scenario, deps) {
  if (!/^[a-z0-9-]{1,40}$/.test(scenario)) throw new Error(`\`${scenario}\` is not a scenario id`);
  const ctx = { gh: deps.gh, repository: SETTINGS.harness };

  // THE LAST CHANGE: the newer of the last commits on main to its steps.json and its start/.
  const last = async (/** @type {string} */ path) => {
    const c = (await api(ctx, `${H}/commits?sha=main&path=${path}&per_page=1`))?.[0];
    return c ? { sha: String(c.sha), date: String(c.commit.committer.date), path } : null;
  };
  const steps = await last(`scenarios/${scenario}/steps.json`);
  if (!steps) throw new Error(`scenarios/${scenario}/steps.json is not on main`);
  const start = await last(`scenarios/${scenario}/start`);
  const since = start && Date.parse(start.date) > Date.parse(steps.date) ? start : steps;

  const releases = (await api(ctx, `${K}/releases?per_page=100`, { paginate: true })).filter((/** @type {any} */ r) => !r.draft);
  /** The latest stable release published by `t`. @param {number} t */
  const stableAt = (t) => releases.map((/** @type {any} */ r) => ({ tag: String(r.tag_name), at: Date.parse(r.published_at ?? r.created_at) }))
    .filter((/** @type {any} */ r) => STABLE.test(r.tag) && r.at <= t).map((/** @type {any} */ r) => r.tag).sort((/** @type {string} */ a, /** @type {string} */ b) => newer(b, a))[0] ?? null;

  // A run that recorded a marker went ahead; one that didn't stopped at `plan`, and is no row.
  const pages = await api(ctx, `${H}/actions/artifacts?per_page=100`, { paginate: true });
  /** @type {Map<number, any[]>} */
  const byRun = new Map();
  for (const a of pages.flatMap((/** @type {any} */ p) => p.artifacts ?? [])) {
    const id = Number(a.workflow_run?.id);
    if (!byRun.has(id)) byRun.set(id, []);
    /** @type {any[]} */ (byRun.get(id)).push(a);
  }
  const marked = [...byRun].filter(([, list]) => list.some((a) => MARKER.test(String(a.name))));

  const runs = [];
  for (const [id, list] of marked) {
    const run = await api(ctx, `${H}/actions/runs/${id}`);
    if (run.path !== WORKFLOW || run.head_branch !== 'main' || run.status !== 'completed') continue;
    // Its commit holds the change, or it ran before it: a re-run keeps its first commit.
    const holds = (await api(ctx, `${H}/compare/${since.sha}...${run.head_sha}`))?.status;
    if (holds !== 'ahead' && holds !== 'identical') continue;
    runs.push({ run, list, startedAt: String(run.run_started_at ?? run.created_at) });
  }
  runs.sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));

  /** @type {Row[]} */
  const rows = [];
  for (const { run, list, startedAt } of runs) {
    const marker = list.find((a) => MARKER.test(String(a.name)));
    const row = (/** @type {string} */ trigger, /** @type {string} */ release, /** @type {string} */ result) => rows.push({
      run: Number(run.id), url: String(run.html_url), startedAt, trigger, release, result, pass: result === 'pass',
    });
    // An expired marker can't say what the run planned, so it can't be taken to have passed.
    if (marker.expired) { row(/** @type {RegExpMatchArray} */ (String(marker.name).match(MARKER))[1], '', 'expired'); continue; }
    const m = await download(ctx, run.id, marker.name, 'marker.json');
    const trigger = /^[a-z]{1,20}$/.test(String(m?.trigger)) ? String(m.trigger) : '';
    const release = RELEASE.test(String(m?.release)) ? String(m.release) : '';
    if (!m || !trigger || !release || !Array.isArray(m.scenarios)) { row(trigger, release, 'unreadable'); continue; }
    if (!m.scenarios.includes(scenario)) continue;
    if (!CANDIDATE.test(release) && release !== stableAt(Date.parse(startedAt))) continue;

    const artifact = list.find((a) => a.name === `kanon-e2e-result-${scenario}`);
    if (!artifact) { row(trigger, release, 'no result'); continue; }
    if (artifact.expired) { row(trigger, release, 'expired'); continue; }
    const r = await download(ctx, run.id, artifact.name, 'result.json');
    row(trigger, release, r?.scenario === scenario && RESULTS.includes(r?.result) ? r.result : 'unreadable');
  }

  const broke = rows.findLastIndex((r) => !r.pass);
  const streak = rows.length - broke - 1;
  return { scenario, since, rows, streak, burntIn: streak >= BURN_IN };
}

/** A run's start, to the minute. @param {string} iso */
const when = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** The table, for the flip's pull request's body. @param {Awaited<ReturnType<typeof count>>} c */
export const render = (c) => {
  const lines = [];
  if (c.rows.length) {
    lines.push('| Run | Date | Trigger | Release | Result |', '|---|---|---|---|---|');
    for (const r of c.rows) lines.push(`| [${r.run}](${r.url}) | ${when(r.startedAt)} | ${r.trigger || '?'} | ${r.release ? `\`${r.release}\`` : '?'} | ${r.pass ? 'pass' : `**${r.result}**`} |`);
  } else {
    lines.push('No run of `e2e.yml` on `main` counts or breaks yet.');
  }
  const passes = `${c.streak} ${c.streak === 1 ? 'pass' : 'passes'} in a row`;
  lines.push('', `**\`${c.scenario}\`: ${passes}**${c.burntIn ? ': burnt in' : ''}, counted from its last change to \`${c.since.path}\` (${c.since.sha.slice(0, 12)}, ${c.since.date}); it needs ${BURN_IN} to turn \`gate: true\` (Kanon plan 0012 §10).`);
  return `${lines.join('\n')}\n`;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const c = await count(process.argv[2] ?? '', { gh: ghProcess(process.env) });
    process.stdout.write(render(c));
    process.exitCode = c.burntIn ? 0 : 1;
  } catch (e) {
    console.error(`burn-in: ${/** @type {Error} */ (e).message}`);
    process.exitCode = 2;
  }
}
