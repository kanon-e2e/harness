import { describe, expect, it } from 'vitest';
import { admit, expectedCost, isModel, recordedCosts } from '../runner/ledger.mjs';
import { SETTINGS } from '../runner/sizing.mjs';
import { stubGh } from './helpers/stubs.mjs';

/**
 * The real-model ledger (Kanon plan 0012 §6.2, decision 7 as changed; step E10). Its criteria:
 * it refuses a scenario whose expected cost would pass $2 and starts one that fits; a scenario with
 * no history runs only by the Owner's dispatch. E10's mutation cell names two tests here that turn
 * red: the ledger without its margin, and a scenario with no history started by the schedule.
 */

const m = (id, gate = false) => ({ id, gate });

describe('the settings the ledger reads', () => {
  it('holds the Owner\'s $2 a run, the margin of 1.5 over the last ten runs, and decision 15\'s two scenarios', () => {
    expect(SETTINGS.ledger).toEqual({ capUsd: 2, margin: 1.5, historyRuns: 10 });
    expect(SETTINGS.maxModelScenarios).toBe(2);
    expect(SETTINGS.$sources.ledger).toMatch(/§6\.2/);
  });
});

describe('a scenario\'s expected cost', () => {
  it('is the largest of its last ten recorded costs, times 1.5', () => {
    expect(expectedCost([0.4, 1.0, 0.7])).toBeCloseTo(1.5);
  });

  it('reads only the last ten: an eleventh, older run\'s cost is forgotten', () => {
    expect(expectedCost([...Array(10).fill(0.2), 5])).toBeCloseTo(0.3);
  });

  it('is unknown with no recorded cost', () => {
    expect(expectedCost([])).toBeNull();
  });

  it('a real-model scenario is one with `claude: subscription` or `tier: model`', () => {
    expect([{ claude: 'subscription' }, { tier: 'model' }, { claude: 'none', tier: 'none' }].map(isModel)).toEqual([true, true, false]);
  });
});

describe('the ledger refuses a scenario whose expected cost would pass $2, and starts one that fits (E10)', () => {
  it('starts one that fits: $1.20 recorded, $1.80 expected', () => {
    const out = admit({ kind: 'nightly', models: [m('review-real')], history: { 'review-real': [1.2] } });
    expect(out.admitted).toEqual([{ id: 'review-real', expectedUsd: expect.closeTo(1.8), reason: expect.stringMatching(/^started: expected \$1\.80/) }]);
    expect(out.refused).toEqual([]);
  });

  it('refuses one whose expected cost alone passes $2: `skipped: budget`', () => {
    const out = admit({ kind: 'poll', models: [m('review-real', true)], history: { 'review-real': [1.4] } });
    expect(out.admitted).toEqual([]);
    expect(out.refused).toEqual([{ id: 'review-real', gate: true, skipped: 'budget', reason: expect.stringMatching(/^skipped: budget.*\$2\.10.*\$2\.00/) }]);
  });

  it('refuses the second when the first already expects most of the $2, and says how much', () => {
    const out = admit({ kind: 'nightly', models: [m('a'), m('b')], history: { a: [1.0], b: [0.4] } });
    expect(out.admitted.map((x) => x.id)).toEqual(['a']);
    expect(out.refused).toEqual([{ id: 'b', gate: false, skipped: 'budget', reason: expect.stringMatching(/\$0\.60.*already expect \$1\.50/) }]);
    expect(out.expectedUsd).toBeCloseTo(1.5);
  });

  it('starts both when together they fit: $1.20 and $0.75 expected', () => {
    const out = admit({ kind: 'nightly', models: [m('a'), m('b')], history: { a: [0.8], b: [0.5] } });
    expect(out.admitted.map((x) => x.id)).toEqual(['a', 'b']);
    expect(out.expectedUsd).toBeCloseTo(1.95);
  });

  it('starts at most two a run (decision 15), whatever they cost', () => {
    const out = admit({ kind: 'nightly', models: [m('a'), m('b'), m('c')], history: { a: [0.01], b: [0.01], c: [0.01] } });
    expect(out.admitted.map((x) => x.id)).toEqual(['a', 'b']);
    expect(out.refused).toEqual([{ id: 'c', gate: false, skipped: null, reason: expect.stringMatching(/at most 2/) }]);
  });

  // MUTATION (E10): the ledger without its margin starts this scenario, and this test turns red.
  it('MUTATION: the margin refuses a scenario whose largest recorded cost fits the $2 only without it', () => {
    const out = admit({ kind: 'nightly', models: [m('review-real')], history: { 'review-real': [1.5] } });
    expect(out.admitted).toEqual([]);
    expect(out.refused).toMatchObject([{ id: 'review-real', skipped: 'budget' }]);
  });
});

describe('a scenario with no history runs only by the Owner\'s dispatch (E10)', () => {
  // MUTATION (E10): a ledger that starts a scenario with no history on the schedule turns this red.
  it('MUTATION: the schedule never starts a scenario with no history, on the poll or the nightly', () => {
    for (const kind of /** @type {const} */ (['poll', 'nightly'])) {
      const out = admit({ kind, models: [m('review-real')], history: {} });
      expect(out.admitted, kind).toEqual([]);
      expect(out.refused, kind).toEqual([{ id: 'review-real', gate: false, skipped: null, reason: expect.stringMatching(new RegExp(`no recorded cost.*dispatch.*a ${kind} never starts it`)) }]);
    }
  });

  it('the Owner\'s dispatch starts it, alone, with nothing to expect', () => {
    const out = admit({ kind: 'dispatch', models: [m('review-real')], history: { 'review-real': [] } });
    expect(out.admitted).toEqual([{ id: 'review-real', expectedUsd: null, reason: expect.stringMatching(/first run, dispatched alone/) }]);
  });

  it('a dispatch that selects it beside another real-model scenario doesn\'t start it: nothing else may run against the cap', () => {
    const out = admit({ kind: 'dispatch', models: [m('new'), m('old')], history: { old: [0.5] } });
    expect(out.admitted.map((x) => x.id)).toEqual(['old']);
    expect(out.refused).toEqual([{ id: 'new', gate: false, skipped: null, reason: expect.stringMatching(/dispatched alone.*selects 2/) }]);
  });

  it('once it has a recorded cost, the schedule runs it under the cap like any other', () => {
    expect(admit({ kind: 'poll', models: [m('review-real')], history: { 'review-real': [0.9] } }).admitted.map((x) => x.id)).toEqual(['review-real']);
  });
});

describe('the history: each scenario\'s recorded costs, from its result artifacts', () => {
  const H = 'repos/kanon-e2e/harness';
  const NAME = 'kanon-e2e-result-review-real';
  const art = (run, minutesAgo, more = {}) => ({ name: NAME, workflow_run: { id: run, head_branch: 'main' }, expired: false, created_at: new Date(Date.parse('2026-10-20T12:00:00Z') - minutesAgo * 60_000).toISOString(), ...more });
  const result = (costUsd, more = {}) => ({ schema: 'kanon-e2e-result/v1', scenario: 'review-real', result: 'pass', costUsd, ...more });
  const read = (artifacts, byRun) => {
    const g = stubGh({ [`GET ${H}/actions/artifacts?name=${NAME}&per_page=100`]: [{ total_count: artifacts.length, artifacts }] });
    const downloaded = [];
    const download = async (_ctx, run, name, file) => {
      downloaded.push([run, name, file]);
      return byRun[run] ?? null;
    };
    return { costs: recordedCosts({ gh: g.gh, repository: 'kanon-e2e/harness' }, 'review-real', { download }), downloaded };
  };

  it('reads `costUsd` from the newest results first, on main, unexpired', async () => {
    const { costs, downloaded } = read(
      [art(1, 300), art(2, 100), art(3, 200), art(4, 50, { expired: true }), art(5, 10, { workflow_run: { id: 5, head_branch: 'feat' } })],
      { 1: result(0.3), 2: result(0.1), 3: result(0.2), 4: result(9), 5: result(9) },
    );
    expect(await costs).toEqual([0.1, 0.2, 0.3]);
    expect(downloaded).toEqual([[2, NAME, 'result.json'], [3, NAME, 'result.json'], [1, NAME, 'result.json']]);
  });

  it('a result with no cost, another scenario\'s, or one that isn\'t a result is no history', async () => {
    const { costs } = read([art(1, 1), art(2, 2), art(3, 3), art(4, 4), art(5, 5)], {
      1: result(undefined), 2: result(0.5, { scenario: 'other' }), 3: { costUsd: 0.5 }, 4: result(-1), 5: result(0.7),
    });
    expect(await costs).toEqual([0.7]);
  });

  it('stops at ten recorded costs', async () => {
    const many = Array.from({ length: 14 }, (_, i) => art(i + 1, i + 1));
    const { costs, downloaded } = read(many, Object.fromEntries(many.map((_, i) => [i + 1, result(i)])));
    expect(await costs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(downloaded).toHaveLength(10);
  });
});
