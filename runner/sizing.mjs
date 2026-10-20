// The run's sizing (Kanon plan 0012 §5.2 "Two runs at once", §5.3; harness #16), derived from the
// harness's settings (runner/settings.json), never hard-coded. One run at a time (the Owner,
// 2026-10-17), so a run is sized for the organisation's limits alone:
//
//   - jobs at once (E0's item 5): a run's max-parallel, times the jobs one scenario holds at once,
//     fits the jobs-at-once setting less the jobs kept for the harness's own lanes and the janitor;
//   - repositories in an hour (E0's item 4): one run's repositories, its catalogue and its `infra`
//     re-runs, fit the setting;
//   - the nightly interval: a run's longest running time, waves included, fits inside it.
//
// A job that `needs:` a matrix waits for all of its entries, so with fewer entries at once than
// scenarios every stage runs in waves, and a repository lives from its `provision` to the last
// wave of `act-3`. The cap is the largest run that fits both limits. It holds what a run plans,
// not the catalogue (the Owner, 2026-10-20): `plan` plans every `gate: true` scenario, then as many
// `gate: false` ones as fit, rotating by the day (`fitCap` in runner/plan.mjs), and refuses a
// dispatch whose selection passes it. So the longest running time below is a bound on every run,
// and the janitor's cut-offs follow it.

import { readFileSync } from 'node:fs';

/** The harness's settings, as runner/settings.json holds them. */
export const SETTINGS = Object.freeze(JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8')));

/** The phases a scenario runs at most, each a `kanon` job and then an `act` job (§5.2). */
export const PHASES = 3;

/** A run's max-parallel for every scenario job. @param {typeof SETTINGS} s */
export const maxParallel = (s = SETTINGS) => {
  const p = Math.floor((s.jobsAtOnce - s.reservedJobs) / s.jobsPerScenario);
  if (p < 1) throw new Error(`jobsAtOnce ${s.jobsAtOnce} leaves no room for one scenario's ${s.jobsPerScenario} jobs beside the ${s.reservedJobs} kept`);
  return p;
};

/** The waves `n` matrix entries run in at `p` at once. @param {number} n @param {number} p */
export const waves = (n, p) => Math.ceil(n / p);

/**
 * Each stage's longest time, in minutes: a `provision` job, each pair's mint plus its job, and
 * the gate before phases 2 and 3 (#62), one job, not a matrix.
 * @param {typeof SETTINGS} s
 */
export const stageMinutes = (s = SETTINGS) => ({
  provision: s.minutes.provision,
  modelKey: s.minutes.mint + s.minutes.modelKey,
  kanon: s.minutes.mint + s.minutes.kanon,
  act: s.minutes.mint + s.minutes.act,
  gate: s.minutes.gate,
});

/**
 * A repository's longest running time, in minutes, in a run of `n` scenarios at the settings'
 * max-parallel: from its `provision` to the end of the last wave of `act-3`, every stage in waves.
 * The real-model scenarios are at most `maxModelScenarios` a run.
 * @param {number} n @param {typeof SETTINGS} s
 */
export const longestRunningMinutes = (n, s = SETTINGS) => {
  if (n <= 0) return 0;
  const p = maxParallel(s);
  const m = stageMinutes(s);
  const w = waves(n, p);
  const wm = waves(Math.min(n, s.maxModelScenarios), p);
  return w * m.provision + wm * m.modelKey + PHASES * w * (m.kanon + m.act) + (PHASES - 1) * m.gate;
};

/** The repositories one run of `n` scenarios creates: each, and its `infra` re-run. @param {number} n */
export const repositoriesOf = (n) => 2 * n;

/**
 * The cap: the most scenarios one run may plan, so that its longest running time fits
 * the nightly interval and its repositories fit the repositories an hour.
 * @param {typeof SETTINGS} s
 */
export const maxScenarios = (s = SETTINGS) => {
  let n = 0;
  while (longestRunningMinutes(n + 1, s) <= s.nightlyIntervalHours * 60 && repositoriesOf(n + 1) <= s.reposPerHour) n++;
  return n;
};

/**
 * The janitor's cut-offs, in minutes (§5.3): the longest running time the catalogue's cap gives,
 * plus the margin for queueing; and, for a repository with the failed topic, 24 hours beyond that.
 * @param {typeof SETTINGS} s
 */
export const janitorCutoffs = (s = SETTINGS) => {
  const cutoff = longestRunningMinutes(maxScenarios(s), s) + s.queueMarginMinutes;
  return { cutoffMinutes: cutoff, failedCutoffMinutes: cutoff + s.failedKeepHours * 60 };
};

/** Every derived value, for the docs and the step summary. @param {typeof SETTINGS} s */
export const sizing = (s = SETTINGS) => {
  const cap = maxScenarios(s);
  return {
    jobsAtOnce: s.jobsAtOnce,
    maxParallel: maxParallel(s),
    maxScenarios: cap,
    longestRunningMinutes: longestRunningMinutes(cap, s),
    nightlyIntervalMinutes: s.nightlyIntervalHours * 60,
    ...janitorCutoffs(s),
  };
};

/** Minutes as `22 h 20 min`. @param {number} m */
export const hours = (m) => `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log(JSON.stringify(sizing(), null, 2));
}
