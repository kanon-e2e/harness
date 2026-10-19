import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BURN_IN, count, render } from '../runner/burn-in.mjs';
import { stubGh } from './helpers/stubs.mjs';

/**
 * `runner/burn-in.mjs` (Kanon plan 0012 §10, step E9; harness #43): a scenario's burn-in, counted
 * by the Owner's rule of 2026-10-18 from the runs of `e2e.yml` on `main`, their markers and
 * results, and Kanon's releases. Every read is stubbed, as `tests/plan.test.mjs` stubs `plan`'s.
 */

const H = 'repos/kanon-e2e/harness';
const K = 'repos/yedeya-labs/kanon';
const ID = 'install-review';
const CHANGE = 'c'.repeat(40);
const T0 = Date.parse('2026-10-18T00:00:00Z');
const at = (hours) => new Date(T0 + hours * 3_600_000).toISOString();

/**
 * One run of `e2e.yml`, as the world holds it. `marker: false` is a run whose `plan` stopped;
 * `result: null` one that planned the scenario and left no result.
 */
const run = (id, o = {}) => ({
  id, hours: id, trigger: 'nightly', release: 'v0.40.2', scenarios: [ID], result: 'pass', marker: true,
  branch: 'main', path: '.github/workflows/e2e.yml', status: 'completed', before: false, expired: [], ...o,
});

/**
 * The world `burn-in` reads: the scenario's last change, Kanon's releases (`v0.40.1` then
 * `v0.40.2` at hour 0, unless `rels` says otherwise), every artifact, and each run.
 */
const world = (runs, { rels = [['v0.40.1', -100], ['candidate-v0.40.2', -50], ['v0.40.2', 0], ['candidate-v0.41.0', 1]], start = null, stepsChange = true } = {}) => {
  const artifacts = runs.flatMap((r) => {
    const own = [];
    const markerName = r.trigger === 'candidate' ? `e2e-candidate-${r.release}` : r.trigger === 'nightly' ? `e2e-nightly-${'a'.repeat(40)}` : `e2e-dispatch-${r.release}`;
    if (r.marker) own.push({ name: markerName, expired: r.expired.includes('marker') });
    if (r.marker && r.result !== null) own.push({ name: `kanon-e2e-result-${ID}`, expired: r.expired.includes('result') });
    own.push({ name: 'verdict', expired: false });
    return own.map((a, i) => ({ id: r.id * 10 + i, ...a, workflow_run: { id: r.id, head_branch: r.branch, head_sha: `h${r.id}` } }));
  });
  const files = Object.fromEntries(runs.flatMap((r) => [
    [`${r.id} ${artifacts.find((a) => a.workflow_run.id === r.id && a.name.startsWith('e2e-'))?.name}`, { 'marker.json': JSON.stringify({ trigger: r.trigger, release: r.release, scenarios: r.scenarios }) }],
    [`${r.id} kanon-e2e-result-${ID}`, { 'result.json': r.resultFile ?? JSON.stringify({ scenario: ID, release: r.release, trigger: r.trigger, result: r.result }) }],
  ]));
  const routes = {
    [`GET ${H}/commits?sha=main&path=scenarios/${ID}/steps.json&per_page=1`]: stepsChange ? [{ sha: CHANGE, commit: { committer: { date: at(-200) } } }] : [],
    [`GET ${H}/commits?sha=main&path=scenarios/${ID}/start&per_page=1`]: start ? [start] : [],
    [`GET ${K}/releases?per_page=100`]: [rels.map(([tag, hours], i) => ({ id: i, tag_name: tag, draft: false, prerelease: tag.startsWith('candidate-'), published_at: at(hours) }))],
    [`GET ${H}/actions/artifacts?per_page=100`]: [{ total_count: artifacts.length, artifacts }],
    ...Object.fromEntries(runs.map((r) => [`GET ${H}/actions/runs/${r.id}`, {
      id: r.id, html_url: `https://github.com/kanon-e2e/harness/actions/runs/${r.id}`, path: r.path, head_branch: r.branch, head_sha: `h${r.id}`,
      status: r.status, created_at: at(r.hours), run_started_at: at(r.hours),
    }])),
    ...Object.fromEntries(runs.map((r) => [`GET ${H}/compare/${start?.sha ?? CHANGE}...h${r.id}`, { status: r.before ? 'behind' : 'ahead' }])),
  };
  const g = stubGh(routes);
  /** `gh run download <run> -R <repo> -n <name> -D <dir>`: writes the artifact's files into `dir`. */
  const gh = async (args, input) => {
    if (args[0] !== 'run' || args[1] !== 'download') return g.gh(args, input);
    g.calls.push({ key: `run download ${args[2]} ${args[4]} -n ${args[6]}`, method: null, args });
    const content = files[`${args[2]} ${args[6]}`];
    if (args[3] !== '-R' || args[4] !== 'kanon-e2e/harness' || args[5] !== '-n' || args[7] !== '-D' || !content) return { status: 1, stdout: '', stderr: 'no artifact' };
    for (const [name, text] of Object.entries(content)) writeFileSync(join(args[8], name), text);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { gh, g };
};

const burnIn = async (runs, opts) => {
  const w = world(runs, opts);
  return { ...(await count(ID, { gh: w.gh })), g: w.g };
};
const passes = (n, from = 1, o = {}) => Array.from({ length: n }, (_, i) => run(from + i, o));

describe('the run of passes (§10, the Owner\'s rule of 2026-10-18)', () => {
  it(`counts ${BURN_IN} passes in a row as burnt in, and ${BURN_IN - 1} as not yet`, async () => {
    expect(BURN_IN).toBe(10);
    const ten = await burnIn(passes(10));
    expect(ten.streak).toBe(10);
    expect(ten.burntIn).toBe(true);
    expect(ten.rows.map((r) => r.run)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const nine = await burnIn(passes(9));
    expect(nine.streak).toBe(9);
    expect(nine.burntIn).toBe(false);
  });

  it('lists the runs oldest first, whatever order the artifacts come in', async () => {
    const out = await burnIn([run(3, { hours: 30 }), run(1, { hours: 10 }), run(2, { hours: 20 })]);
    expect(out.rows.map((r) => r.run)).toEqual([1, 2, 3]);
  });

  it('breaks the run on a `fail`, and lists the run that broke it', async () => {
    const out = await burnIn([...passes(3), run(4, { result: 'fail' }), ...passes(2, 5)]);
    expect(out.streak).toBe(2);
    expect(out.rows.map((r) => [r.run, r.result, r.pass])).toContainEqual([4, 'fail', false]);
  });

  it('breaks the run on `infra`, on `skipped`, and on a run that planned the scenario and left no result: only a pass counts', async () => {
    for (const o of [{ result: 'infra' }, { result: 'skipped' }, { result: null }]) {
      const out = await burnIn([...passes(3), run(4, o), ...passes(2, 5)]);
      expect(out.streak, JSON.stringify(o)).toBe(2);
      expect(out.rows.find((r) => r.run === 4)).toMatchObject({ pass: false, result: o.result ?? 'no result' });
    }
  });

  it('breaks the run on a result it can\'t read, or one that names another scenario', async () => {
    for (const resultFile of ['{ not json', JSON.stringify({ scenario: 'install-build', result: 'pass' })]) {
      const out = await burnIn([...passes(3), run(4, { resultFile }), ...passes(2, 5)]);
      expect(out.streak).toBe(2);
      expect(out.rows.find((r) => r.run === 4)).toMatchObject({ pass: false, result: 'unreadable' });
    }
  });

  it('breaks the run on an expired artifact: it can\'t say the run passed', async () => {
    for (const expired of [['marker'], ['result']]) {
      const out = await burnIn([...passes(3), run(4, { expired }), ...passes(2, 5)]);
      expect(out.streak).toBe(2);
      expect(out.rows.find((r) => r.run === 4)).toMatchObject({ pass: false, result: 'expired' });
    }
  });
});

describe('what counts and what neither counts nor breaks', () => {
  it('a run that gave way neither counts nor breaks the run of passes, and is not listed', async () => {
    // A nightly whose `plan` stopped for a candidate's run in flight records no marker.
    const out = await burnIn([...passes(5), run(6, { marker: false, result: 'fail' }), ...passes(5, 7)]);
    expect(out.streak).toBe(10);
    expect(out.burntIn).toBe(true);
    expect(out.rows.map((r) => r.run)).not.toContain(6);
  });

  it('a dispatched run against the latest release counts, and so does one against a candidate, whatever started it', async () => {
    const out = await burnIn([
      ...passes(3, 1, { trigger: 'dispatch' }), ...passes(3, 4, { trigger: 'candidate', release: 'candidate-v0.41.0' }),
      ...passes(2, 7, { trigger: 'dispatch', release: 'candidate-v0.40.2' }), ...passes(2, 9),
    ]);
    expect(out.streak).toBe(10);
    expect(out.rows.map((r) => r.trigger)).toEqual(['dispatch', 'dispatch', 'dispatch', 'candidate', 'candidate', 'candidate', 'dispatch', 'dispatch', 'nightly', 'nightly']);
  });

  it('a run against an older stable release neither counts nor breaks', async () => {
    // v0.40.2 is out at hour 0, so a dispatch at v0.40.1 is against an older stable release.
    const pass = await burnIn([...passes(9), run(10, { trigger: 'dispatch', release: 'v0.40.1' })]);
    expect(pass.streak).toBe(9);
    expect(pass.burntIn).toBe(false);
    expect(pass.rows.map((r) => r.run)).not.toContain(10);
    const fail = await burnIn([...passes(5), run(6, { trigger: 'dispatch', release: 'v0.40.1', result: 'fail' }), ...passes(5, 7)]);
    expect(fail.streak).toBe(10);
  });

  it('takes the latest stable release when the run started, not today\'s', async () => {
    // Before v0.40.2 was published, v0.40.1 was the latest stable release.
    const out = await burnIn([run(1, { hours: -10, release: 'v0.40.1' }), run(2, { hours: -5, release: 'v0.40.2' })]);
    expect(out.rows.map((r) => [r.run, r.release])).toEqual([[1, 'v0.40.1']]);
    expect(out.streak).toBe(1);
  });

  it('takes no stable release Kanon hadn\'t published when the run started', async () => {
    const out = await burnIn([run(1, { release: 'v9.9.9' })], { rels: [['v0.40.2', 0]] });
    expect(out.rows).toEqual([]);
    expect(out.streak).toBe(0);
  });

  it('breaks the run on a marker it can\'t read: one that names no exact release or no trigger', async () => {
    // `plan` writes only an exact release and its trigger, so anything else is no marker of its.
    for (const o of [{ release: 'main' }, { trigger: 'Nightly | x' }]) {
      const out = await burnIn([...passes(3), run(4, o), ...passes(2, 5)]);
      expect(out.streak, JSON.stringify(o)).toBe(2);
      expect(out.rows.find((r) => r.run === 4)).toMatchObject({ pass: false, result: 'unreadable' });
    }
  });

  it('a run that didn\'t plan this scenario neither counts nor breaks', async () => {
    const out = await burnIn([...passes(5), run(6, { trigger: 'dispatch', scenarios: ['install-build'], result: 'fail' }), ...passes(5, 7)]);
    expect(out.streak).toBe(10);
    expect(out.rows.map((r) => r.run)).not.toContain(6);
  });

  it('counts from the last change to its `steps.json` or `start/`: a run before it neither counts nor breaks', async () => {
    const out = await burnIn([run(1, { before: true }), run(2, { before: true, result: 'fail' }), ...passes(3, 3)]);
    expect(out.rows.map((r) => r.run)).toEqual([3, 4, 5]);
    expect(out.streak).toBe(3);
    expect(out.since).toMatchObject({ sha: CHANGE, path: `scenarios/${ID}/steps.json` });
    const start = { sha: 'd'.repeat(40), commit: { committer: { date: at(-100) } } };
    const later = await burnIn(passes(2), { start });
    expect(later.since).toMatchObject({ sha: start.sha, path: `scenarios/${ID}/start` });
    expect(later.g.calls.map((c) => c.key)).toContain(`GET ${H}/compare/${start.sha}...h1`);
  });

  it('reads only `e2e.yml`\'s completed runs on `main`', async () => {
    const out = await burnIn([
      ...passes(5), run(6, { branch: 'fix', result: 'fail' }), run(7, { path: '.github/workflows/probe-13-reporter-check-run.yml', result: 'fail' }),
      run(8, { status: 'in_progress', result: null }), ...passes(5, 9),
    ]);
    expect(out.streak).toBe(10);
    expect(out.rows.map((r) => r.run)).toEqual([1, 2, 3, 4, 5, 9, 10, 11, 12, 13]);
  });
});

describe('what it reads, and what it writes', () => {
  it('writes nothing: every call is a GET or an artifact\'s download', async () => {
    const out = await burnIn([...passes(3), run(4, { result: 'fail' })]);
    expect(out.g.writes()).toEqual([]);
    for (const c of out.g.calls) expect(c.method === 'GET' || c.key.startsWith('run download '), c.key).toBe(true);
  });

  it('refuses a scenario that isn\'t on `main`, and an id that isn\'t one', async () => {
    await expect(burnIn([], { stepsChange: false })).rejects.toThrow(/scenarios\/install-review\/steps\.json is not on main/);
    await expect(count('../x', { gh: world([]).gh })).rejects.toThrow(/is not a scenario id/);
  });
});

describe('the table', () => {
  it('prints a Markdown table, oldest first, of each run that counts or breaks, then the run of passes', async () => {
    const out = await burnIn([...passes(2), run(3, { result: 'fail' }), run(4, { marker: false }), ...passes(1, 5, { trigger: 'candidate', release: 'candidate-v0.41.0' })]);
    const md = render(out);
    expect(md.split('\n').filter((l) => l.startsWith('|'))).toEqual([
      '| Run | Date | Trigger | Release | Result |',
      '|---|---|---|---|---|',
      `| [${1}](https://github.com/kanon-e2e/harness/actions/runs/1) | 2026-10-18 01:00 UTC | nightly | \`v0.40.2\` | pass |`,
      `| [${2}](https://github.com/kanon-e2e/harness/actions/runs/2) | 2026-10-18 02:00 UTC | nightly | \`v0.40.2\` | pass |`,
      `| [${3}](https://github.com/kanon-e2e/harness/actions/runs/3) | 2026-10-18 03:00 UTC | nightly | \`v0.40.2\` | **fail** |`,
      `| [${5}](https://github.com/kanon-e2e/harness/actions/runs/5) | 2026-10-18 05:00 UTC | candidate | \`candidate-v0.41.0\` | pass |`,
    ]);
    expect(md).toContain(`**\`${ID}\`: 1 pass in a row**`);
    expect(md).toContain(`it needs ${BURN_IN}`);
    expect(md).toContain(CHANGE.slice(0, 12));
  });

  it('says when a scenario is burnt in', async () => {
    expect(render(await burnIn(passes(10)))).toContain(`**\`${ID}\`: 10 passes in a row**: burnt in`);
  });

  it('says so when no run counts yet', async () => {
    expect(render(await burnIn([]))).toContain('No run of `e2e.yml` on `main` counts or breaks yet.');
  });
});
