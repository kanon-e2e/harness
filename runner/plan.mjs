#!/usr/bin/env node
// `plan`, the run's first job (Kanon plan 0012 §5.2, §7; harness #16). It decides whether the run
// goes ahead, and with what, before any repository is created, reading Kanon only through its
// public API and the harness only through its own artifacts:
//
//   the poll (every 15 minutes, decision 19): the latest candidate newer than the latest stable
//     release, when its Reporter check run is missing, or completed `neutral` over an hour ago,
//     and it has had fewer than six runs (each counted by its `e2e-candidate-<tag>` artifact);
//   the nightly (once a day, decision 4): when Kanon's main moved since the last nightly, or none
//     ran in seven days, the latest candidate if newer than the stable, else the stable; its
//     `e2e-nightly-<main head>` artifact records the head it ran;
//   a dispatch: an exact release, the whole catalogue or one scenario or family. The whole
//     catalogue for a candidate is a candidate's run: it posts the check run and counts.
//
// ONE RUN AT A TIME (the Owner, 2026-10-17): a run whose `plan` recorded a marker is in flight
// until it ends. While one is, a nightly gives way ("skipped: a candidate's run covers tonight"
// when it is a candidate's), the poll waits for the next tick, and a dispatch stops. A nightly
// that gave way records no marker, so the next night isn't held by it.
//
//   node runner/plan.mjs   (reads EVENT, SCHEDULE, RELEASE, SELECT, GITHUB_RUN_ID, GH_TOKEN;
//                           writes GITHUB_OUTPUT, the step summary and MARKER_DIR/marker.json)

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { api } from './lib/gh.mjs';
import { RELEASE } from './lib/kanon.mjs';
import { ghProcess } from './lib/proc.mjs';
import { maxScenarios, SETTINGS } from './sizing.mjs';
import { loadScenario, scenarioDirs } from './validate.mjs';

const K = `repos/${SETTINGS.kanon}`;
const H = `repos/${SETTINGS.harness}`;
const CANDIDATE = /^candidate-v(\d+)\.(\d+)\.(\d+)$/;
const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
const MARKER = /^e2e-(nightly|candidate|dispatch)-/;

/** A tag's version, for comparison. @param {string} tag */
const version = (tag) => tag.replace(/^candidate-v|^v/, '').split('.').map(Number);
/** @param {string} a @param {string} b */
const newer = (a, b) => {
  const [x, y] = [version(a), version(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The latest stable release and the latest candidate, by version. @param {any[]} releases */
const latest = (releases) => {
  const tags = releases.filter((r) => !r.draft).map((r) => String(r.tag_name));
  const top = (/** @type {RegExp} */ re) => tags.filter((t) => re.test(t)).sort((a, b) => newer(b, a))[0] ?? null;
  return { stable: top(STABLE), candidate: top(CANDIDATE) };
};

/** What a scenario job takes of a scenario, and `verdict` its `gate`, from the catalogue at the run's commit. @param {any} s */
const entry = (s) => ({ id: s.id, apps: s.apps, claude: s.claude, gate: s.gate === true });

/** @typedef {{ go: boolean, trigger: string, release: string, candidateSha: string, scenarios: any[], modelScenarios: any[], marker: string, reason: string }} Decision */

/** A run that doesn't go ahead. @param {string} trigger @param {string} reason @returns {Decision} */
const stop = (trigger, reason) => ({ go: false, trigger, release: '', candidateSha: '', scenarios: [], modelScenarios: [], marker: '', reason });

/**
 * Decides the run.
 * @param {{ event: string, schedule: string, release: string, select: string, runId: string, catalogue: any[] }} input
 * @param {{ gh: (args: string[], input?: string) => Promise<any>, now: () => number }} deps
 * @returns {Promise<Decision>}
 */
export async function decide(input, deps) {
  const ctx = { gh: deps.gh, repository: SETTINGS.harness };
  const cap = maxScenarios();
  if (input.catalogue.length > cap) throw new Error(`the catalogue holds ${input.catalogue.length} scenarios, past its cap of ${cap}: one run of it would outlast the nightly interval or the repositories an hour (runner/sizing.mjs)`);

  const kind = input.event === 'workflow_dispatch' ? 'dispatch'
    : input.event === 'schedule' && input.schedule === SETTINGS.schedules.poll ? 'poll'
      : input.event === 'schedule' && input.schedule === SETTINGS.schedules.nightly ? 'nightly' : null;
  if (!kind) throw new Error(`plan runs on the poll's schedule, the nightly's or a dispatch, not \`${input.event}\` \`${input.schedule}\``);

  /** @type {any[]} */
  let chosen = input.catalogue;
  if (kind === 'dispatch') {
    if (!RELEASE.test(input.release)) throw new Error(`\`${input.release}\` is not an exact Kanon release (vX.Y.Z or candidate-vX.Y.Z)`);
    if (input.select) {
      chosen = input.catalogue.filter((s) => s.id === input.select || s.family === input.select);
      if (!chosen.length) throw new Error(`\`${input.select}\` names no scenario and no family of the catalogue`);
    }
  } else {
    // A scheduled run holds no real-model scenario until E10 decides how they are scheduled.
    chosen = input.catalogue.filter((s) => s.tier !== 'model');
  }
  const trigger = kind === 'poll' ? 'candidate' : kind;
  if (!chosen.length) return stop(trigger, 'there is no scenario to run in scenarios/');

  // ONE RUN AT A TIME: a run of this workflow in flight, other than this one, that recorded a marker.
  const runs = (await api(ctx, `${H}/actions/workflows/e2e.yml/runs?status=in_progress&per_page=100`))?.workflow_runs ?? [];
  for (const run of runs) {
    if (String(run.id) === String(input.runId)) continue;
    const names = ((await api(ctx, `${H}/actions/runs/${run.id}/artifacts?per_page=100`))?.artifacts ?? []).map((/** @type {any} */ x) => String(x.name));
    const marker = names.find((n) => MARKER.test(n));
    if (!marker) continue;
    const what = /** @type {RegExpMatchArray} */ (marker.match(MARKER))[1];
    if (kind === 'nightly') return stop(trigger, what === 'candidate' ? 'skipped: a candidate\'s run covers tonight' : `skipped: the run ${run.id} (${marker}) is in flight; one run at a time`);
    if (kind === 'poll') return stop(trigger, `waiting: the ${what} run ${run.id} (${marker}) is in flight; the poll asks again at its next tick`);
    return stop(trigger, `stopped: the ${what} run ${run.id} (${marker}) is in flight; one run at a time`);
  }

  /** The Reporter's latest check run on a commit, or null. @param {string} sha */
  const latestCheck = async (sha) => {
    const list = (await api(ctx, `${K}/commits/${sha}/check-runs?check_name=${SETTINGS.checkName}&filter=all&per_page=100`))?.check_runs ?? [];
    return list.filter((/** @type {any} */ c) => c.app?.slug === SETTINGS.reporterAppSlug)
      .sort((/** @type {any} */ x, /** @type {any} */ y) => Date.parse(y.started_at) - Date.parse(x.started_at))[0] ?? null;
  };
  /** The workflow runs that recorded an artifact named `name`. @param {string} name */
  const recorded = async (name) => {
    const pages = await api(ctx, `${H}/actions/artifacts?name=${name}&per_page=100`, { paginate: true });
    return pages.flatMap((/** @type {any} */ p) => p.artifacts ?? []);
  };
  const sha = async (/** @type {string} */ ref) => String((await api(ctx, `${K}/commits/${ref}`)).sha);
  const go = (/** @type {Partial<Decision>} */ d) => {
    const scenarios = chosen.map(entry);
    return /** @type {Decision} */ ({ go: true, trigger, candidateSha: '', scenarios, modelScenarios: scenarios.filter((s) => s.claude === 'subscription'), reason: '', ...d });
  };

  if (kind === 'dispatch') {
    const head = await sha(input.release);
    if (!input.select && CANDIDATE.test(input.release)) {
      const c = await latestCheck(head);
      if (c && c.status !== 'completed') return stop('candidate', `stopped: ${input.release}'s check run is ${c.status}`);
      const marker = `e2e-candidate-${input.release}`;
      return go({ trigger: 'candidate', release: input.release, candidateSha: head, marker, reason: `dispatched: the whole catalogue for the candidate ${input.release}` });
    }
    return go({ trigger: 'dispatch', release: input.release, marker: `e2e-dispatch-${input.release}`, reason: `dispatched: ${input.select || 'the whole catalogue'} at ${input.release}` });
  }

  const releases = await api(ctx, `${K}/releases?per_page=100`, { paginate: true });
  const { stable, candidate } = latest(releases);
  const fresh = candidate && (!stable || newer(candidate, stable) > 0) ? candidate : null;

  if (kind === 'poll') {
    if (!fresh) return stop(trigger, `no candidate newer than ${stable ?? 'any stable release'}`);
    const head = await sha(fresh);
    const c = await latestCheck(head);
    if (c) {
      if (c.status !== 'completed') return stop(trigger, `${fresh}'s check run is ${c.status}`);
      if (c.conclusion !== 'neutral') return stop(trigger, `${fresh}'s check run completed ${c.conclusion}`);
      const since = (deps.now() - Date.parse(c.completed_at)) / 60_000;
      if (since <= SETTINGS.neutralRerunAfterMinutes) return stop(trigger, `${fresh}'s check run completed neutral ${Math.floor(since)} minutes ago; re-run after ${SETTINGS.neutralRerunAfterMinutes}`);
    }
    const marker = `e2e-candidate-${fresh}`;
    const count = new Set((await recorded(marker)).map((x) => x.workflow_run?.id)).size;
    if (count >= SETTINGS.candidateRunsMax) return stop(trigger, `${fresh} has had ${count} runs; at most ${SETTINGS.candidateRunsMax} runs for one candidate`);
    return go({ release: fresh, candidateSha: head, marker, reason: `the candidate ${fresh}${c ? `, neutral since ${c.completed_at}` : ', with no check run'}` });
  }

  // THE NIGHTLY.
  const main = await sha('main');
  const marker = `e2e-nightly-${main}`;
  const floor = SETTINGS.nightlyFloorDays * 24 * 60 * 60_000;
  const last = (await recorded(marker)).filter((x) => !x.expired && deps.now() - Date.parse(x.created_at) <= floor);
  if (last.length) return stop(trigger, `held: Kanon's main is still ${main.slice(0, 12)}, which the nightly ran at ${last[0].created_at}`);
  const release = fresh ?? stable;
  if (!release) return stop(trigger, 'no release of Kanon to run');
  return go({ release, marker, reason: `Kanon's main is ${main.slice(0, 12)}; running ${release}` });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const catalogue = scenarioDirs().map((d) => loadScenario(d).scenario);
  const d = await decide({
    event: env.EVENT ?? '', schedule: env.SCHEDULE ?? '', release: (env.RELEASE ?? '').trim(), select: (env.SELECT ?? '').trim(), runId: env.GITHUB_RUN_ID ?? '', catalogue,
  }, { gh: ghProcess(env), now: Date.now });
  const out = [
    `go=${d.go}`, `trigger=${d.trigger}`, `release=${d.release}`, `candidate-sha=${d.candidateSha}`,
    `scenarios=${JSON.stringify(d.scenarios)}`, `model-scenarios=${JSON.stringify(d.modelScenarios)}`, `marker=${d.marker}`, `reason=${d.reason.replace(/\s+/g, ' ')}`,
  ];
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${out.join('\n')}\n`);
  if (d.go && env.MARKER_DIR) {
    mkdirSync(env.MARKER_DIR, { recursive: true });
    writeFileSync(join(env.MARKER_DIR, 'marker.json'), `${JSON.stringify({ marker: d.marker, trigger: d.trigger, release: d.release, candidateSha: d.candidateSha, scenarios: d.scenarios.map((s) => s.id) }, null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## plan\n\n${d.go ? `**Goes ahead**: ${d.trigger} run of ${d.release}, ${d.scenarios.length} scenario(s): ${d.scenarios.map((s) => `\`${s.id}\``).join(', ')}.` : '**Stops here**; no repository is created.'}\n\n${d.reason}\n`);
  }
  console.log(JSON.stringify(d, null, 2));
}
