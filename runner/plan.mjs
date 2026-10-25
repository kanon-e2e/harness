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
// THE CAP (runner/sizing.mjs) holds what a run PLANS, not the whole catalogue (the Owner,
// 2026-10-20). A scheduled run, or a dispatch of the whole catalogue, plans every `gate: true`
// scenario, then as many `gate: false` ones as fit under the cap, rotating by the day: the
// `gate: false` scenarios, sorted by id, are taken in a window that moves by its own length each
// UTC day, so every one runs within ceil(gate: false scenarios / room) consecutive days. A dispatch
// of a scenario or a family plans what it selects, and is refused only when that selection passes
// the cap. When the gating scenarios alone pass the cap, `plan` fails, as no run could gate.
//
// RUNS ON (#139; the Owner, 2026-10-25): a scenario whose `runsOn` leaves out this kind of run
// is dropped before the cap, so it takes no rotation slot. The poll and a whole-catalogue dispatch
// for a candidate are `candidate`, the nightly `scheduled`, any other dispatch `dispatch`; a
// `select=<id>` runs its scenario whatever its `runsOn`.
//
// THE REAL-MODEL LEDGER (§6.2, E10; runner/ledger.mjs): each `claude: subscription` scenario the
// run would hold is admitted or refused before any repository is created. One refused for its
// expected cost is left out of the matrix and handed to `verdict` as `skipped: budget`; one with
// no recorded cost runs only on a dispatch, alone, and is otherwise left out, with the reason in
// the summary. A gating one refused for any reason is handed to `verdict` too (#107). A refused scenario gets no repository and no model token.
// On the poll and the nightly, a `gate: false` one with no recorded cost is set aside before the
// cap: it takes no rotation slot, and the cap's "leaves out" doesn't name it (#109).
//
//   node runner/plan.mjs   (reads EVENT, SCHEDULE, RELEASE, SELECT, GITHUB_RUN_ID, GH_TOKEN;
//                           writes GITHUB_OUTPUT, the step summary and MARKER_DIR/marker.json)

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { api } from './lib/gh.mjs';
import { RELEASE } from './lib/kanon.mjs';
import { admit, isModel, recordedCosts } from './ledger.mjs';
import { ghProcess } from './lib/proc.mjs';
import { maxScenarios, SETTINGS } from './sizing.mjs';
import { loadScenario, runsOn, scenarioDirs } from './validate.mjs';

const K = `repos/${SETTINGS.kanon}`;
const H = `repos/${SETTINGS.harness}`;
export const CANDIDATE = /^candidate-v(\d+)\.(\d+)\.(\d+)$/;
export const STABLE = /^v(\d+)\.(\d+)\.(\d+)$/;
export const MARKER = /^e2e-(nightly|candidate|dispatch)-/;

/** A tag's version, for comparison. @param {string} tag */
const version = (tag) => tag.replace(/^candidate-v|^v/, '').split('.').map(Number);
/** @param {string} a @param {string} b */
export const newer = (a, b) => {
  const [x, y] = [version(a), version(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The latest stable release and the latest candidate, by version. @param {any[]} releases */
const latest = (releases) => {
  const tags = releases.filter((r) => !r.draft).map((r) => String(r.tag_name));
  const top = (/** @type {RegExp} */ re) => tags.filter((t) => re.test(t)).sort((a, b) => newer(b, a))[0] ?? null;
  return { stable: top(STABLE), candidate: top(CANDIDATE) };
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * What a run plans under the cap: every gating scenario, then a window of the `gate: false` ones,
 * sorted by id, starting at `day × room` (mod their count), `room` being what the gating ones leave.
 * Consecutive days take consecutive windows, so each `gate: false` scenario is planned within
 * ceil(count / room) days. The planned scenarios keep the catalogue's order.
 * @param {any[]} catalogue @param {number} cap @param {number} day whole UTC days since the epoch
 * @returns {{ planned: any[], left: string[] }}
 */
export function fitCap(catalogue, cap, day) {
  const gating = catalogue.filter((s) => s.gate === true);
  if (gating.length > cap) throw new Error(`the catalogue holds ${gating.length} \`gate: true\` scenarios, past the cap of ${cap} a run may hold: one run of them would outlast the nightly interval or the repositories an hour (runner/sizing.mjs)`);
  const free = catalogue.filter((s) => s.gate !== true).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const room = cap - gating.length;
  if (free.length <= room) return { planned: catalogue, left: [] };
  const start = (day * room) % free.length;
  const picked = new Set(Array.from({ length: room }, (_, i) => free[(start + i) % free.length].id));
  return { planned: catalogue.filter((s) => s.gate === true || picked.has(s.id)), left: free.filter((s) => !picked.has(s.id)).map((s) => s.id) };
}

/** What a scenario job takes of a scenario, and `verdict` its `gate`, from the catalogue at the run's commit. @param {any} s */
const entry = (s) => ({ id: s.id, apps: s.apps, claude: s.claude, gate: s.gate === true });

/**
 * `authorLabels` is the planned scenarios whose `authorLabel` the `author-label` job applies after
 * phase 1, for its matrix. `left` is the `gate: false` scenarios the cap left out of this run, by
 * id; `skipped` is the scenarios the ledger refused for their cost, and the gating ones it refused for any reason (#107), each with its `skipped` word, for `verdict`;
 * `ledger` is every real-model scenario's admission or refusal, with its reason.
 * @typedef {{ go: boolean, trigger: string, release: string, candidateSha: string, scenarios: any[], modelScenarios: any[], authorLabels: Array<{ id: string, head: string, label: string }>, left: string[], skipped: any[], ledger: Array<{ id: string, started: boolean, reason: string }>, marker: string, reason: string }} Decision
 */

/** A run that doesn't go ahead. @param {string} trigger @param {string} reason @param {Decision['ledger']} [ledger] @returns {Decision} */
const stop = (trigger, reason, ledger = []) => ({ go: false, trigger, release: '', candidateSha: '', scenarios: [], modelScenarios: [], authorLabels: [], left: [], skipped: [], ledger, marker: '', reason });

/**
 * Decides the run.
 * @param {{ event: string, schedule: string, release: string, select: string, runId: string, catalogue: any[] }} input
 * @param {{ gh: (args: string[], input?: string) => Promise<any>, now: () => number }} deps
 * @returns {Promise<Decision>}
 */
export async function decide(input, deps) {
  const ctx = { gh: deps.gh, repository: SETTINGS.harness };
  const cap = maxScenarios();

  const kind = input.event === 'workflow_dispatch' ? 'dispatch'
    : input.event === 'schedule' && input.schedule === SETTINGS.schedules.poll ? 'poll'
      : input.event === 'schedule' && input.schedule === SETTINGS.schedules.nightly ? 'nightly' : null;
  if (!kind) throw new Error(`plan runs on the poll's schedule, the nightly's or a dispatch, not \`${input.event}\` \`${input.schedule}\``);

  // RUNS ON (#139): the kind of run this is, as a scenario's `runsOn` names it. The poll, and a
  // dispatch of the whole catalogue for a candidate, are a candidate's run; the nightly is
  // `scheduled`, whatever release it runs; any other dispatch is `dispatch`, but a `select=<id>`
  // runs the scenario it names whatever its `runsOn` says. A scenario kept out is gone before the
  // cap, so it takes no rotation slot.
  const runKind = kind === 'nightly' ? 'scheduled'
    : kind === 'poll' || (!input.select && CANDIDATE.test(input.release)) ? 'candidate' : 'dispatch';
  /** @type {any[]} */
  let chosen = input.catalogue.filter((s) => runsOn(s, runKind));
  if (kind === 'dispatch') {
    if (!RELEASE.test(input.release)) throw new Error(`\`${input.release}\` is not an exact Kanon release (vX.Y.Z or candidate-vX.Y.Z)`);
    if (input.select) {
      chosen = input.catalogue.filter((s) => s.id === input.select || (s.family === input.select && runsOn(s, 'dispatch')));
      if (!chosen.length && input.catalogue.some((s) => s.family === input.select)) throw new Error(`\`${input.select}\`'s scenarios each leave \`dispatch\` out of \`runsOn\`: dispatch one by its id`);
      if (!chosen.length) throw new Error(`\`${input.select}\` names no scenario and no family of the catalogue`);
    }
  }
  // THE CAP, on what this run plans. A selection is held to it here; anything else is fitted to it
  // in `go`, once the ledger has read the history (#109), and checked here only so that gating
  // scenarios past the cap fail `plan` before it reads anything.
  /** @type {string[]} */
  let left = [];
  const day = Math.floor(deps.now() / DAY_MS);
  const capped = !(kind === 'dispatch' && input.select);
  if (!capped) {
    if (chosen.length > cap) throw new Error(`\`${input.select}\` selects ${chosen.length} scenarios, past the cap of ${cap} a run may hold: one run of them would outlast the nightly interval or the repositories an hour (runner/sizing.mjs)`);
  } else fitCap(chosen, cap, day);
  const trigger = kind === 'poll' ? 'candidate' : kind;
  if (!input.catalogue.length) return stop(trigger, 'there is no scenario to run in scenarios/');
  if (!chosen.length) return stop(trigger, `no scenario in scenarios/ runs on the ${kind === 'nightly' ? 'nightly' : kind === 'poll' ? 'poll' : 'dispatch'}: each one's \`runsOn\` leaves out \`${runKind}\``);

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
  // THE LEDGER, last, once the run is going ahead: it reads the real-model scenarios' history.
  // On the poll and the nightly, a `gate: false` one with no recorded cost, which the ledger
  // refuses there whatever the cap does, is set aside BEFORE the cap, so it takes no rotation
  // slot and the cap fills that slot with a scenario that starts (#109). The ledger still refuses
  // it, with its reason, and the cap's "leaves out" names only what the cap kept out. A gating
  // one stays in (the cap plans every one, and its refusal reaches `verdict`, #107); a dispatch
  // fits the cap first, as before, since it may start one with no history, alone.
  const go = async (/** @type {Partial<Decision>} */ d) => {
    /** The cap, on `chosen` less the scenarios `aside`, which stay in for the ledger. @param {Set<string>} aside */
    const fit = (aside) => {
      const fitted = fitCap(chosen.filter((s) => !aside.has(s.id)), cap, day);
      left = fitted.left;
      const planned = new Set(fitted.planned.map((s) => s.id));
      chosen = chosen.filter((s) => planned.has(s.id) || aside.has(s.id));
    };
    if (capped && kind === 'dispatch') fit(new Set());
    /** @type {Record<string, number[]>} */
    const history = {};
    for (const m of chosen.filter(isModel)) history[m.id] = await recordedCosts(ctx, m.id);
    if (capped && kind !== 'dispatch') fit(new Set(chosen.filter((s) => isModel(s) && s.gate !== true && !history[s.id].length).map((s) => s.id)));
    const models = chosen.filter(isModel);
    const { admitted, refused } = admit({ kind, models: models.map(entry), history });
    const refusedIds = new Set(refused.map((r) => r.id));
    const ledger = [...admitted.map((a) => ({ id: a.id, started: true, reason: a.reason })), ...refused.map((r) => ({ id: r.id, started: false, reason: r.reason }))];
    const scenarios = chosen.filter((s) => !refusedIds.has(s.id)).map(entry);
    if (!scenarios.length) return stop(d.trigger ?? trigger, `every scenario selected was refused by the real-model ledger: ${refused.map((r) => `${r.id} (${r.reason})`).join('; ')}`, ledger);
    const note = left.length ? `; the cap of ${cap} leaves out, this time: ${left.join(', ')}` : '';
    return /** @type {Decision} */ ({
      go: true, trigger, candidateSha: '', ...d, reason: `${d.reason ?? ''}${note}`, scenarios, ledger, left,
      modelScenarios: scenarios.filter(isModel),
      authorLabels: chosen.filter((s) => !refusedIds.has(s.id) && s.authorLabel).map((s) => ({ id: s.id, head: s.authorLabel.head, label: s.authorLabel.label })),
      skipped: refused.filter((r) => r.skipped).map((r) => ({ id: r.id, gate: r.gate, skipped: r.skipped })),
    });
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

/**
 * The run's `marker.json`: what it planned, and what the ledger refused as `skipped`, which no
 * job's result records, so `burn-in` reads it from here (#111).
 * @param {Decision} d
 */
export const markerOf = (d) => ({
  marker: d.marker, trigger: d.trigger, release: d.release, candidateSha: d.candidateSha,
  scenarios: d.scenarios.map((s) => s.id), skipped: d.skipped.map((s) => ({ id: s.id, skipped: s.skipped })),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const catalogue = scenarioDirs().map((d) => loadScenario(d).scenario);
  const d = await decide({
    event: env.EVENT ?? '', schedule: env.SCHEDULE ?? '', release: (env.RELEASE ?? '').trim(), select: (env.SELECT ?? '').trim(), runId: env.GITHUB_RUN_ID ?? '', catalogue,
  }, { gh: ghProcess(env), now: Date.now });
  const out = [
    `go=${d.go}`, `trigger=${d.trigger}`, `release=${d.release}`, `candidate-sha=${d.candidateSha}`,
    `scenarios=${JSON.stringify(d.scenarios)}`, `model-scenarios=${JSON.stringify(d.modelScenarios)}`, `author-labels=${JSON.stringify(d.authorLabels)}`, `skipped=${JSON.stringify(d.skipped)}`, `marker=${d.marker}`, `reason=${d.reason.replace(/\s+/g, ' ')}`,
  ];
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${out.join('\n')}\n`);
  if (d.go && env.MARKER_DIR) {
    mkdirSync(env.MARKER_DIR, { recursive: true });
    writeFileSync(join(env.MARKER_DIR, 'marker.json'), `${JSON.stringify(markerOf(d), null, 2)}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const ledger = d.ledger.length ? `\n### The real-model ledger ($${SETTINGS.ledger.capUsd} a run)\n\n${d.ledger.map((l) => `- \`${l.id}\`: ${l.reason}`).join('\n')}\n` : '';
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## plan\n\n${d.go ? `**Goes ahead**: ${d.trigger} run of ${d.release}, ${d.scenarios.length} scenario(s): ${d.scenarios.map((s) => `\`${s.id}\``).join(', ')}.` : '**Stops here**; no repository is created.'}\n\n${d.reason}\n${ledger}`);
  }
  console.log(JSON.stringify(d, null, 2));
}
