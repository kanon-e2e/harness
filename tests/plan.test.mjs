import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, fitCap, markerOf } from '../runner/plan.mjs';
import { maxScenarios, SETTINGS } from '../runner/sizing.mjs';
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

/**
 * A real-model scenario's past results on `main`, newest first: each a run id and the `costUsd`
 * its result records. `plan`'s ledger reads them (E10).
 */
const results = (id, costs) => [{ total_count: costs.length, artifacts: costs.map((_, i) => ({ name: `kanon-e2e-result-${id}`, workflow_run: { id: 500 + i, head_branch: 'main' }, expired: false, created_at: ago(60 * (i + 1)) })) }];

/** The world `plan` reads, for a candidate `candidate-v0.42.0` on top of stable `v0.41.0`. */
const world = ({ checks = [], candidateRuns = [], inFlight = [], nightlyRecord = null, main = MAIN, rels = releases('candidate-v0.42.0', 'v0.41.0'), history = [] } = {}) => ({
  [`GET ${H}/actions/artifacts?name=kanon-e2e-result-review-real&per_page=100`]: results('review-real', history),
  [DOWNLOADS]: Object.fromEntries(history.map((cost, i) => [500 + i, { schema: 'kanon-e2e-result/v1', scenario: 'review-real', result: 'pass', costUsd: cost }])),
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

const DOWNLOADS = Symbol('downloads');
/**
 * `gh`, stubbed: `run download <run> … -n <name> -D <dir>` writes the result the world holds for
 * that run into `dir`, as `gh` would; every other call goes to the routes.
 */
const plan = async (input, { [DOWNLOADS]: downloads = {}, ...routes }) => {
  const g = stubGh(routes);
  const gh = async (args, body) => {
    if (args[0] !== 'run' || args[1] !== 'download') return g.gh(args, body);
    const r = downloads[args[2]];
    if (!r) return { status: 1, stdout: '', stderr: 'no artifact' };
    writeFileSync(join(args[args.indexOf('-D') + 1], 'result.json'), JSON.stringify(r));
    return { status: 0, stdout: '', stderr: '' };
  };
  const out = await decide({ catalogue: CATALOGUE, runId: '999', release: '', select: '', schedule: '', ...input }, { gh, now: () => NOW });
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
      { id: 'deploy-rehearsal', apps: ['releaser'], claude: 'none', gate: false },
      { id: 'install-review', apps: ['author', 'judge'], claude: 'none', gate: false },
    ]);
    expect(out.modelScenarios).toEqual([]);
  });

  it('carries each scenario\'s `gate` from the catalogue at the run\'s commit, for `verdict` (E8)', async () => {
    const catalogue = CATALOGUE.map((s) => (s.id === 'install-review' ? { ...s, gate: true } : s));
    const out = await plan({ event: 'schedule', schedule: POLL, catalogue }, world());
    expect(out.scenarios.map((s) => [s.id, s.gate])).toEqual([['deploy-rehearsal', false], ['install-review', true]]);
  });

  it('skips a candidate whose Reporter check run is `in_progress`, `success` or `failure`', async () => {
    for (const c of [check('in_progress'), check('queued'), check('completed', 'success', 600), check('completed', 'failure', 600)]) {
      const out = await poll(world({ checks: [c] }));
      expect(out.go, `${c.status} ${c.conclusion}`).toBe(false);
      expect(out.reason).toMatch(/candidate-v0\.42\.0/);
      expect(out.reason).toContain(c.status === 'completed' ? c.conclusion : c.status);
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
    expect(out.reason).toMatch(/^waiting: the nightly run/);
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
    expect(out.modelScenarios).toEqual([{ id: 'review-real', apps: ['author', 'judge'], claude: 'subscription', gate: false }]);
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

  it('reads Kanon only through its public API; an error reading it fails `plan`, never a run', async () => {
    await expect(poll({ ...world(), [`GET ${K}/releases?per_page=100`]: fail('HTTP 404') })).rejects.toThrow();
  });
});

describe('the cap holds what a run plans, gating scenarios first (the Owner, 2026-10-20)', () => {
  const CAP = maxScenarios();
  const DAY = 24 * 60 * 60_000;
  const sc = (id, gate) => ({ ...CATALOGUE[1], id, gate });
  /** 6 gating and 12 `gate: false` scenarios: 18, past the cap of 14, leaving room for 8. */
  const gating = Array.from({ length: 6 }, (_, i) => sc(`g-${i}`, true));
  const free = Array.from({ length: 12 }, (_, i) => sc(`f-${String(i).padStart(2, '0')}`, false));
  const big = [...free.slice(0, 6), ...gating, ...free.slice(6)];
  const ids = (out) => out.scenarios.map((s) => s.id);
  const at = (days) => () => NOW + days * DAY;
  const planAt = (days, input, routes) => {
    const g = stubGh(routes);
    return decide({ catalogue: big, runId: '999', release: '', select: '', schedule: '', ...input }, { gh: g.gh, now: at(days) });
  };

  it('a catalogue past the cap no longer fails the run: the nightly and the poll plan exactly the cap', async () => {
    expect(big.length).toBeGreaterThan(CAP);
    for (const input of [{ event: 'schedule', schedule: NIGHTLY }, { event: 'schedule', schedule: POLL }]) {
      const out = await planAt(0, input, world());
      expect(out.go).toBe(true);
      expect(out.scenarios).toHaveLength(CAP);
      expect(out.left).toHaveLength(big.length - CAP);
      expect(out.reason).toMatch(/the cap of 14 leaves out, this time: f-/);
    }
  });

  // MUTATION: a plan that drops a gating scenario to fit turns this red.
  it('MUTATION: every gating scenario is planned on every day, whatever the rotation', async () => {
    for (let day = 0; day < 10; day++) {
      const out = await planAt(day, { event: 'schedule', schedule: NIGHTLY }, world());
      for (const g of gating) expect(ids(out), `day ${day}`).toContain(g.id);
      expect(out.left.every((id) => id.startsWith('f-')), `day ${day}`).toBe(true);
    }
  });

  it('rotates the `gate: false` ones: each is planned within ceil(12 / 8) = 2 consecutive days, from any day', async () => {
    for (let first = 0; first < 5; first++) {
      const seen = new Set();
      for (let day = first; day < first + 2; day++) for (const id of ids(await planAt(day, { event: 'schedule', schedule: NIGHTLY }, world()))) seen.add(id);
      for (const f of free) expect(seen.has(f.id), `${f.id} from day ${first}`).toBe(true);
    }
  });

  it('keeps the catalogue\'s order, and plans everything when it fits', () => {
    const { planned } = fitCap(big, CAP, 3);
    expect(planned.map((s) => s.id)).toEqual(big.map((s) => s.id).filter((id) => planned.some((s) => s.id === id)));
    expect(fitCap(big.slice(0, CAP), CAP, 3)).toEqual({ planned: big.slice(0, CAP), left: [] });
  });

  it('a dispatch of the whole catalogue rotates as a scheduled run does', async () => {
    const out = await planAt(0, { event: 'workflow_dispatch', release: 'candidate-v0.42.0' }, world());
    expect(out).toMatchObject({ go: true, trigger: 'candidate' });
    expect(out.scenarios).toHaveLength(CAP);
  });

  it('a dispatch plans what it selects, and is refused only when the selection itself passes the cap', async () => {
    const family = await planAt(0, { event: 'workflow_dispatch', release: 'v0.41.0', select: 'install' }, world()).catch((e) => e);
    expect(family.message).toMatch(/`install` selects 18 scenarios, past the cap of 14/);
    const one = await planAt(0, { event: 'workflow_dispatch', release: 'v0.41.0', select: 'f-03' }, world());
    expect(one).toMatchObject({ go: true, left: [] });
    expect(ids(one)).toEqual(['f-03']);
  });

  it('fails as before when the gating scenarios alone pass the cap', async () => {
    const all = Array.from({ length: CAP + 1 }, (_, i) => sc(`g-${i}`, true));
    await expect(plan({ event: 'schedule', schedule: NIGHTLY, catalogue: all }, world())).rejects.toThrow(/15 `gate: true` scenarios, past the cap of 14/);
  });

  it('the real catalogue under scenarios/ plans on a nightly, today', async () => {
    const { scenarioDirs, loadScenario } = await import('../runner/validate.mjs');
    const catalogue = scenarioDirs().map((d) => loadScenario(d).scenario);
    const out = await plan({ event: 'schedule', schedule: NIGHTLY, catalogue }, world());
    expect(out.go).toBe(true);
    expect(out.scenarios.length).toBeLessThanOrEqual(CAP);
    for (const g of catalogue.filter((s) => s.gate === true)) expect(ids(out)).toContain(g.id);
  });
});

describe('the real-model ledger in `plan` (§6.2, E10)', () => {
  const ids = (out) => out.scenarios.map((s) => s.id);

  it('the poll starts a real-model scenario whose expected cost fits the $2, and hands it to `model-key`', async () => {
    const out = await poll(world({ history: [0.8, 1.0, 0.6] }));
    expect(ids(out)).toEqual(['deploy-rehearsal', 'install-review', 'review-real']);
    expect(out.modelScenarios).toEqual([{ id: 'review-real', apps: ['author', 'judge'], claude: 'subscription', gate: false }]);
    expect(out.skipped).toEqual([]);
    expect(out.ledger).toEqual([{ id: 'review-real', started: true, reason: expect.stringMatching(/expected \$1\.50/) }]);
  });

  it('the nightly refuses one whose expected cost would pass the $2: `skipped: budget`, with no repository and no model token', async () => {
    const out = await nightly(world({ history: [1.4] }));
    expect(out.go).toBe(true);
    expect(ids(out)).toEqual(['deploy-rehearsal', 'install-review']);
    expect(out.modelScenarios).toEqual([]);
    expect(out.skipped).toEqual([{ id: 'review-real', gate: false, skipped: 'budget' }]);
    expect(out.ledger[0]).toMatchObject({ id: 'review-real', started: false, reason: expect.stringMatching(/^skipped: budget.*\$2\.10/) });
  });

  it('records a scenario refused as `skipped: budget` in the run\'s marker, beside the ones it planned, for `burn-in` (#111)', async () => {
    const out = await nightly(world({ history: [1.4] }));
    expect(markerOf(out)).toEqual({
      marker: `e2e-nightly-${MAIN}`, trigger: 'nightly', release: out.release, candidateSha: '',
      scenarios: ['deploy-rehearsal', 'install-review'], skipped: [{ id: 'review-real', skipped: 'budget' }],
    });
    // One refused with no `skipped` word isn't handed to `verdict`, so the marker doesn't list it either.
    expect(markerOf(await nightly(world()))).toMatchObject({ scenarios: ['deploy-rehearsal', 'install-review'], skipped: [] });
  });

  it('the poll and the nightly never start a scenario with no recorded cost, and say why; nothing reads it as `skipped`', async () => {
    for (const run of [poll, nightly]) {
      const out = await run(world());
      expect(out.go).toBe(true);
      expect(ids(out)).not.toContain('review-real');
      expect(out.modelScenarios).toEqual([]);
      expect(out.skipped).toEqual([]);
      expect(out.ledger).toEqual([{ id: 'review-real', started: false, reason: expect.stringMatching(/no recorded cost.*dispatch/) }]);
    }
  });

  it('the Owner\'s dispatch starts a scenario with no recorded cost, alone', async () => {
    const out = await dispatch('candidate-v0.42.0', world(), 'review-real');
    expect(out).toMatchObject({ go: true, trigger: 'dispatch' });
    expect(ids(out)).toEqual(['review-real']);
    expect(out.ledger).toEqual([{ id: 'review-real', started: true, reason: expect.stringMatching(/first run, dispatched alone/) }]);
  });

  it('a dispatch whose only scenario the ledger refuses stops at `plan`: no repository, no run', async () => {
    const out = await dispatch('candidate-v0.42.0', world({ history: [3] }), 'review-real');
    expect(out).toMatchObject({ go: false, scenarios: [], modelScenarios: [], marker: '' });
    expect(out.reason).toMatch(/refused by the real-model ledger: review-real \(skipped: budget/);
  });

  it('hands the `author-label` job each planned scenario\'s `authorLabel`, and none for a scenario the ledger left out (E10)', async () => {
    const labelled = CATALOGUE.map((x) => (x.id === 'review-real' ? { ...x, authorLabel: { head: 'docs-note', label: 'review:please' } } : x));
    const ran = await plan({ event: 'schedule', schedule: POLL, catalogue: labelled }, world({ history: [0.5] }));
    expect(ran.authorLabels).toEqual([{ id: 'review-real', head: 'docs-note', label: 'review:please' }]);
    const refused = await plan({ event: 'schedule', schedule: POLL, catalogue: labelled }, world({ history: [3] }));
    expect(refused.authorLabels).toEqual([]);
    expect((await plan({ event: 'schedule', schedule: POLL, catalogue: labelled }, world())).authorLabels).toEqual([]);
  });

  it('reads the history only for a run that goes ahead, and only for the real-model scenarios', async () => {
    const held = await nightly(world({ nightlyRecord: ago(60) }));
    expect(held.g.calls.some((c) => /kanon-e2e-result-/.test(c.key))).toBe(false);
    const ran = await poll(world({ history: [0.5] }));
    expect(ran.g.calls.filter((c) => /kanon-e2e-result-/.test(c.key)).map((c) => c.key)).toEqual([`GET ${H}/actions/artifacts?name=kanon-e2e-result-review-real&per_page=100`]);
  });
});
