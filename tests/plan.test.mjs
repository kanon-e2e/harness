import { describe, expect, it } from 'vitest';
import { decide } from '../runner/plan.mjs';
import { SETTINGS } from '../runner/sizing.mjs';
import { fail, stubGh } from './helpers/stubs.mjs';

/**
 * `plan`, the run's first job (Kanon plan 0012 §5.2, §7; harness #16). It decides whether a run
 * goes ahead before any repository is created: the poll's candidate, the nightly's hold, the
 * dispatch, and one run at a time (the Owner, 2026-10-17). Every read is stubbed.
 */

const NOW = Date.parse('2026-10-17T12:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const POLL = SETTINGS.schedules.poll;
const NIGHTLY = SETTINGS.schedules.nightly;
const K = 'repos/yedeya-labs/kanon';
const H = 'repos/kanon-e2e/harness';
const SHA = 'c'.repeat(40);
const MAIN = 'a'.repeat(40);

const CATALOGUE = [
  { id: 'deploy-rehearsal', family: 'deploy', tier: 'none', gate: false, apps: ['releaser'], claude: 'none', deadlineMinutes: 120 },
  { id: 'install-review', family: 'install', tier: 'none', gate: false, apps: ['author', 'judge'], claude: 'none', deadlineMinutes: 60 },
  { id: 'review-real', family: 'lane', tier: 'model', gate: false, apps: ['author', 'judge'], claude: 'subscription', deadlineMinutes: 60 },
];

const releases = (...tags) => [tags.map((tag, i) => ({ tag_name: tag, prerelease: tag.startsWith('candidate-'), draft: false, id: i }))];
const check = (status, conclusion = null, completedMinutesAgo = 0, slug = SETTINGS.reporterAppSlug) => ({
  name: 'kanon-e2e', status, conclusion, app: { slug }, started_at: ago(completedMinutesAgo + 30), completed_at: status === 'completed' ? ago(completedMinutesAgo) : null, id: Math.random(),
});
const artifacts = (name, runs) => [{ total_count: runs.length, artifacts: runs.map((id) => ({ name, workflow_run: { id }, expired: false, created_at: ago(60) })) }];

/** The world `plan` reads, for a candidate `candidate-v0.42.0` on top of stable `v0.41.0`. */
const world = ({ checks = [], candidateRuns = [], inFlight = [], nightlyRecord = null, main = MAIN, rels = releases('candidate-v0.42.0', 'v0.41.0') } = {}) => ({
  [`GET ${K}/releases?per_page=100`]: rels,
  [`GET ${K}/commits/candidate-v0.42.0`]: { sha: SHA },
  [`GET ${K}/commits/v0.41.0`]: { sha: 'b'.repeat(40) },
  [`GET ${K}/commits/main`]: { sha: main },
  [`GET ${K}/commits/${SHA}/check-runs?check_name=kanon-e2e&filter=all&per_page=100`]: { total_count: checks.length, check_runs: checks },
  [`GET ${H}/actions/artifacts?name=e2e-candidate-candidate-v0.42.0&per_page=100`]: artifacts('e2e-candidate-candidate-v0.42.0', candidateRuns),
  [`GET ${H}/actions/workflows/e2e.yml/runs?status=in_progress&per_page=100`]: { workflow_runs: [{ id: 999 }, ...inFlight.map(([id]) => ({ id }))] },
  ...Object.fromEntries(inFlight.map(([id, marker]) => [`GET ${H}/actions/runs/${id}/artifacts?per_page=100`, { artifacts: marker ? [{ name: marker }] : [] }])),
  [`GET ${H}/actions/artifacts?name=e2e-nightly-${main}&per_page=100`]: nightlyRecord ? [{ total_count: 1, artifacts: [{ name: `e2e-nightly-${main}`, workflow_run: { id: 5 }, created_at: nightlyRecord, expired: false }] }] : [{ total_count: 0, artifacts: [] }],
});

const plan = async (input, routes) => {
  const g = stubGh(routes);
  const out = await decide({ catalogue: CATALOGUE, runId: '999', release: '', select: '', schedule: '', ...input }, { gh: g.gh, now: () => NOW });
  return { ...out, g };
};
const poll = (routes) => plan({ event: 'schedule', schedule: POLL }, routes);
const nightly = (routes) => plan({ event: 'schedule', schedule: NIGHTLY }, routes);
const dispatch = (release, routes, select = '') => plan({ event: 'workflow_dispatch', release, select }, routes);

describe('the poll (§7, decision 19)', () => {
  it('runs a candidate with no check run, records it as `e2e-candidate-<tag>`, and picks the no-model scenarios', async () => {
    const out = await poll(world());
    expect(out).toMatchObject({ go: true, trigger: 'candidate', release: 'candidate-v0.42.0', candidateSha: SHA, marker: 'e2e-candidate-candidate-v0.42.0' });
    expect(out.scenarios).toEqual([
      { id: 'deploy-rehearsal', apps: ['releaser'], claude: 'none' },
      { id: 'install-review', apps: ['author', 'judge'], claude: 'none' },
    ]);
    expect(out.modelScenarios).toEqual([]);
  });

  it('skips a candidate whose Reporter check run is `in_progress`, `success` or `failure`', async () => {
    for (const c of [check('in_progress'), check('queued'), check('completed', 'success', 600), check('completed', 'failure', 600)]) {
      const out = await poll(world({ checks: [c] }));
      expect(out.go, `${c.status} ${c.conclusion}`).toBe(false);
      expect(out.reason).toMatch(/candidate-v0\.42\.0/);
    }
  });

  it('re-runs a candidate whose check run completed `neutral` more than an hour ago, and not sooner', async () => {
    expect((await poll(world({ checks: [check('completed', 'neutral', 61)] }))).go).toBe(true);
    const soon = await poll(world({ checks: [check('completed', 'neutral', 59)] }));
    expect(soon.go).toBe(false);
    expect(soon.reason).toMatch(/neutral/);
  });

  it('reads only the latest check run, and only the Reporter\'s', async () => {
    const older = { ...check('completed', 'success', 600), id: 1 };
    const newer = { ...check('completed', 'neutral', 90), id: 2, started_at: ago(10) };
    expect((await poll(world({ checks: [older, newer] }))).go).toBe(true);
    expect((await poll(world({ checks: [check('in_progress', null, 0, 'someone-else')] }))).go).toBe(true);
  });

  it('starts no seventh run for one candidate, counted from the `e2e-candidate-<tag>` artifacts, with or without a check run', async () => {
    const six = [1, 2, 3, 4, 5, 6];
    const without = await poll(world({ candidateRuns: six }));
    expect(without.go).toBe(false);
    expect(without.reason).toMatch(/six runs|6 runs/);
    expect((await poll(world({ candidateRuns: six, checks: [check('completed', 'neutral', 120)] }))).go).toBe(false);
    // Runs that failed at `start` posted no check run, and still count.
    expect((await poll(world({ candidateRuns: [1, 2, 3, 4, 5] }))).go).toBe(true);
  });

  it('a scheduled run that waited in the concurrency group re-reads the check run, and stops before creating a repository', async () => {
    const out = await poll(world({ checks: [check('completed', 'success', 1)] }));
    expect(out).toMatchObject({ go: false, scenarios: [], marker: '' });
    expect(out.g.writes()).toEqual([]);
  });

  it('has nothing to run when there is no candidate', async () => {
    expect(await poll(world({ rels: releases('v0.41.0') }))).toMatchObject({ go: false, reason: expect.stringMatching(/no candidate/) });
  });
});

describe('the nightly (§7, decision 4)', () => {
  it('runs the latest candidate when Kanon\'s main changed, recording the head it ran', async () => {
    const out = await nightly(world());
    expect(out).toMatchObject({ go: true, trigger: 'nightly', release: 'candidate-v0.42.0', candidateSha: '', marker: `e2e-nightly-${MAIN}` });
  });

  it('runs the latest stable release when no candidate is newer', async () => {
    expect((await nightly(world({ rels: releases('candidate-v0.41.0', 'v0.41.0') })))).toMatchObject({ go: true, release: 'v0.41.0' });
  });

  it('a held night stops after `plan`: main is the head the last nightly recorded, within seven days', async () => {
    const out = await nightly(world({ nightlyRecord: ago(24 * 60) }));
    expect(out).toMatchObject({ go: false, scenarios: [], marker: '' });
    expect(out.reason).toMatch(/^held/);
  });

  it('the seven-day floor: a night runs when the last nightly ran more than seven days ago', async () => {
    expect((await nightly(world({ nightlyRecord: ago(7 * 24 * 60 + 1) }))).go).toBe(true);
  });
});

describe('one run at a time (§5.2, §7; the Owner, 2026-10-17)', () => {
  it('a nightly\'s plan ends with "skipped: a candidate\'s run covers tonight" while a candidate\'s run is in flight', async () => {
    const out = await nightly(world({ inFlight: [[7, 'e2e-candidate-candidate-v0.42.0']] }));
    expect(out).toMatchObject({ go: false, reason: 'skipped: a candidate\'s run covers tonight', marker: '' });
  });

  it('the poll leaves a candidate alone while a nightly is in flight', async () => {
    const out = await poll(world({ inFlight: [[7, `e2e-nightly-${MAIN}`]] }));
    expect(out.go).toBe(false);
    expect(out.reason).toMatch(/nightly/);
  });

  it('a dispatch stops at `plan` while a nightly or a candidate\'s run is in flight', async () => {
    for (const marker of [`e2e-nightly-${MAIN}`, 'e2e-candidate-candidate-v0.42.0', 'e2e-dispatch-v0.41.0']) {
      const out = await dispatch('v0.41.0', world({ inFlight: [[7, marker]] }));
      expect(out.go, marker).toBe(false);
      expect(out.reason, marker).toMatch(/^stopped/);
    }
  });

  it('a run in flight that went no further than its own `plan` (no marker) holds nothing up, nor does this run itself', async () => {
    expect((await nightly(world({ inFlight: [[7, null]] }))).go).toBe(true);
  });

  it('a nightly that gave way records no `main` head, so the next night isn\'t held', async () => {
    // The last nightly ran an older head; tonight's gives way to a candidate's run and records nothing.
    const gaveWay = await nightly(world({ inFlight: [[7, 'e2e-candidate-candidate-v0.42.0']] }));
    expect(gaveWay.marker).toBe('');
    // The next night, with no nightly record of today's head, isn't held.
    expect((await nightly(world())).go).toBe(true);
  });
});

describe('the dispatch (§7)', () => {
  it('a dispatch for a candidate whose check run is `in_progress` stops at `plan` before creating a repository', async () => {
    const out = await dispatch('candidate-v0.42.0', world({ checks: [check('in_progress')] }));
    expect(out).toMatchObject({ go: false, scenarios: [] });
    expect(out.reason).toMatch(/^stopped.*in_progress/);
  });

  it('a dispatch of the whole catalogue for a candidate is a candidate\'s run: it posts a check run and counts toward the six', async () => {
    const out = await dispatch('candidate-v0.42.0', world({ checks: [check('completed', 'failure', 10)], candidateRuns: [1, 2, 3, 4, 5, 6] }));
    expect(out).toMatchObject({ go: true, trigger: 'candidate', candidateSha: SHA, marker: 'e2e-candidate-candidate-v0.42.0' });
    expect(out.scenarios.map((s) => s.id)).toEqual(['deploy-rehearsal', 'install-review', 'review-real']);
    expect(out.modelScenarios).toEqual([{ id: 'review-real', apps: ['author', 'judge'], claude: 'subscription' }]);
  });

  it('a dispatch of a scenario or a family runs just those, and posts no check run', async () => {
    const one = await dispatch('candidate-v0.42.0', world(), 'install-review');
    expect(one).toMatchObject({ go: true, trigger: 'dispatch', candidateSha: '', marker: 'e2e-dispatch-candidate-v0.42.0' });
    expect(one.scenarios.map((s) => s.id)).toEqual(['install-review']);
    expect((await dispatch('v0.41.0', world(), 'deploy')).scenarios.map((s) => s.id)).toEqual(['deploy-rehearsal']);
  });

  it('refuses a release that isn\'t exact, and a selection that names nothing', async () => {
    await expect(dispatch('main', world())).rejects.toThrow(/exact/);
    await expect(dispatch('v0.41.0', world(), 'no-such')).rejects.toThrow(/no-such/);
  });
});

describe('the catalogue', () => {
  it('has nothing to run with no scenario', async () => {
    expect(await plan({ event: 'schedule', schedule: NIGHTLY, catalogue: [] }, world())).toMatchObject({ go: false, reason: expect.stringMatching(/no scenario/) });
  });

  it('refuses a run past the catalogue\'s cap, so a run always ends inside the nightly interval', async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ ...CATALOGUE[1], id: `s-${i}` }));
    await expect(plan({ event: 'schedule', schedule: NIGHTLY, catalogue: many }, world())).rejects.toThrow(/14/);
  });

  it('reads Kanon only through its public API; an error reading it fails `plan`, never a run', async () => {
    await expect(poll({ ...world(), [`GET ${K}/releases?per_page=100`]: fail('HTTP 404') })).rejects.toThrow();
  });
});
