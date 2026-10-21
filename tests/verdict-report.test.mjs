import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RESULT_STEPS, actJob } from '../runner/evidence.mjs';
import { attest, give, judge, REPORTER_TITLE, redTitle, withSkipped } from '../runner/verdict.mjs';
import { describeCall, tempDir, writeTree } from './helpers/stubs.mjs';
import { readWorkflows } from './helpers/workflows.mjs';

/**
 * `verdict` and `report` (Kanon plan 0012 §5.2, §8.2, §8.3; harness #16, then E8, #40): the
 * verdict over the scenarios that count (on a candidate's run, those with `gate: true`; on any
 * other run, every planned scenario), the red issue per candidate and the `the Reporter can't
 * post` issue that `verdict` files, edits and closes, `verdict`'s exit status, and `report`'s
 * conclusion and summary on the Reporter's check run.
 */

const H = 'kanon-e2e/harness';
const RELEASE = 'candidate-v0.41.0';
const SHA = 'adb944e62a1d38bcb15078d3d64b69bc19920c38';
const BOT = { login: 'github-actions[bot]', type: 'Bot' };

const result = (scenario, r, more = {}) => ({ schema: 'kanon-e2e-result/v1', scenario, result: r, ...more });
const gating = (...ids) => ids.map((id) => ({ id, gate: true }));
const free = (...ids) => ids.map((id) => ({ id, gate: false }));
const run = (id = '39117109753', attempt = '1') => ({ id, attempt, url: `https://github.com/${H}/actions/runs/${id}` });
/** An `act` job of `scenario`'s in the run's jobs list that finalized it with `r`: its one result step ran, the others were skipped. */
const actOf = (scenario, r, { phase = 1, conclusion = 'success' } = {}) => ({
  name: actJob(phase, scenario), conclusion, steps: ['pass', 'fail', 'infra'].map((x) => ({ name: RESULT_STEPS[x], conclusion: x === r ? 'success' : 'skipped' })),
});

describe('verdict: the scenarios that count, and pass, fail or infra-only', () => {
  it('on a candidate\'s run, passes only when every scenario with `gate: true` read `pass`; a `gate: false` one is listed with its result and changes nothing', () => {
    const v = judge({ trigger: 'candidate', planned: [...gating('a'), ...free('b')], results: [result('a', 'pass'), result('b', 'fail')], startResult: 'success' });
    expect(v.verdict).toBe('pass');
    expect(v.scenarios).toEqual([{ id: 'a', gate: true, counts: true, result: 'pass' }, { id: 'b', gate: false, counts: false, result: 'fail' }]);
    expect(judge({ trigger: 'candidate', planned: [...gating('a', 'c'), ...free('b')], results: [result('a', 'pass'), result('b', 'pass'), result('c', 'fail')], startResult: 'success' }).verdict).toBe('fail');
  });

  it('on a nightly or a dispatch, every planned scenario counts: a dispatch of one failing `gate: false` scenario reads `fail` (#35)', () => {
    expect(judge({ trigger: 'dispatch', planned: free('a'), results: [result('a', 'fail')], startResult: 'skipped' })).toMatchObject({ verdict: 'fail', scenarios: [{ id: 'a', gate: false, counts: true, result: 'fail' }] });
    expect(judge({ trigger: 'nightly', planned: [...free('a'), ...gating('b')], results: [result('a', 'infra'), result('b', 'pass')], startResult: 'skipped' }).verdict).toBe('infra-only');
    expect(judge({ trigger: 'nightly', planned: free('a', 'b'), results: [result('a', 'pass'), result('b', 'pass')], startResult: 'skipped' }).verdict).toBe('pass');
  });

  it('reads `gate` from the planned catalogue, never from a result artifact', () => {
    // A result that claims `gate` changes nothing: b stays out of the gate, and a stays in it.
    const v = judge({ trigger: 'candidate', planned: [...gating('a'), ...free('b')], results: [result('a', 'pass', { gate: false }), result('b', 'fail', { gate: true })], startResult: 'success' });
    expect(v).toMatchObject({ verdict: 'pass', scenarios: [{ id: 'a', gate: true, counts: true }, { id: 'b', gate: false, counts: false }] });
    // Only `gate: true` gates: anything else the plan carries is `false`.
    expect(judge({ trigger: 'candidate', planned: [{ id: 'a', gate: 'true' }, { id: 'b' }], results: [result('a', 'pass'), result('b', 'pass')], startResult: 'success' }).scenarios.map((s) => s.gate)).toEqual([false, false]);
  });

  it('a gating scenario whose result is `infra` or missing gives `infra-only`, unless another gating scenario failed', () => {
    expect(judge({ trigger: 'candidate', planned: gating('a', 'b'), results: [result('a', 'pass'), result('b', 'infra')], startResult: 'success' }).verdict).toBe('infra-only');
    expect(judge({ trigger: 'candidate', planned: gating('a', 'b'), results: [result('a', 'pass')], startResult: 'success' })).toMatchObject({ verdict: 'infra-only', scenarios: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'missing' }] });
    expect(judge({ trigger: 'candidate', planned: gating('a', 'b', 'c'), results: [result('a', 'fail'), result('b', 'infra')], startResult: 'success' }).verdict).toBe('fail');
    // A `gate: false` failure doesn't turn a gating `infra` into `fail`.
    expect(judge({ trigger: 'candidate', planned: [...gating('a'), ...free('b')], results: [result('a', 'infra'), result('b', 'fail')], startResult: 'success' }).verdict).toBe('infra-only');
  });

  it('a candidate\'s run with no `gate: true` scenario never answers `pass`: `fail`, no scenario gates yet', () => {
    expect(judge({ trigger: 'candidate', planned: free('a', 'b'), results: [result('a', 'pass'), result('b', 'pass')], startResult: 'success' })).toMatchObject({ verdict: 'fail', reason: 'no scenario gates yet' });
    expect(judge({ trigger: 'candidate', planned: [], results: [], startResult: 'success' }).verdict).toBe('fail');
  });

  it('`skipped: budget` on a gating scenario fails the verdict; on a `gate: false` one it is listed and changes nothing', () => {
    const skipped = result('m', 'skipped', { skipped: 'budget' });
    expect(judge({ trigger: 'candidate', planned: gating('a', 'm'), results: [result('a', 'pass'), skipped], startResult: 'success' })).toMatchObject({
      verdict: 'fail', reason: expect.stringMatching(/skipped: m \(budget\)/), scenarios: [{ id: 'a', result: 'pass' }, { id: 'm', gate: true, result: 'skipped', skipped: 'budget' }],
    });
    expect(judge({ trigger: 'candidate', planned: [...gating('a'), ...free('m')], results: [result('a', 'pass'), skipped], startResult: 'success' })).toMatchObject({ verdict: 'pass', scenarios: [{}, { id: 'm', counts: false, result: 'skipped', skipped: 'budget' }] });
    // Every planned scenario counts off a candidate's run, so a skipped one fails there too.
    expect(judge({ trigger: 'nightly', planned: free('m'), results: [skipped], startResult: 'skipped' }).verdict).toBe('fail');
  });

  it('the ledger\'s refusals reach `verdict` from `plan`\'s `skipped` output: planned, `skipped: budget`, over any result claiming otherwise (E10)', () => {
    const joined = withSkipped(gating('a'), [result('a', 'pass'), result('m', 'pass')], [{ id: 'm', gate: true, skipped: 'budget' }]);
    expect(joined.planned).toEqual([{ id: 'a', gate: true }, { id: 'm', gate: true }]);
    expect(judge({ trigger: 'candidate', ...joined, startResult: 'success' })).toMatchObject({
      verdict: 'fail', scenarios: [{ id: 'a', result: 'pass' }, { id: 'm', gate: true, result: 'skipped', skipped: 'budget' }],
    });
    const free_ = withSkipped(gating('a'), [result('a', 'pass')], [{ id: 'm', gate: false, skipped: 'budget' }]);
    expect(judge({ trigger: 'candidate', ...free_, startResult: 'success' })).toMatchObject({ verdict: 'pass', scenarios: [{}, { id: 'm', counts: false, result: 'skipped' }] });
    expect(withSkipped(gating('a'), [result('a', 'pass')], [])).toEqual({ planned: gating('a'), results: [result('a', 'pass')] });
  });

  it('a `skipped` result says why in `skipped`, a short word; without one it is read as missing', () => {
    for (const why of [undefined, '', 'Budget', 'a reason with spaces', 7]) {
      expect(judge({ trigger: 'candidate', planned: gating('m'), results: [result('m', 'skipped', { skipped: why })], startResult: 'success' }).scenarios[0].result, String(why)).toBe('missing');
    }
  });

  it('answers infra-only when nothing failed but something was infra or has no result; never pass', () => {
    expect(judge({ planned: free('a', 'b'), results: [result('a', 'pass'), result('b', 'infra')], startResult: 'skipped' }).verdict).toBe('infra-only');
    expect(judge({ planned: free('a', 'b'), results: [result('a', 'pass')], startResult: 'skipped' })).toMatchObject({ verdict: 'infra-only', scenarios: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'missing' }] });
  });

  it('with `start` failed, answers infra-only: the Reporter can\'t post', () => {
    expect(judge({ trigger: 'candidate', planned: gating('a'), results: [], startResult: 'failure' })).toMatchObject({ verdict: 'infra-only', reason: expect.stringMatching(/Reporter/) });
  });

  it('a candidate\'s red issue that holds an open `fail` turns any other verdict into `fail`', () => {
    const held = { url: `https://github.com/${H}/issues/7` };
    expect(judge({ trigger: 'candidate', planned: gating('a'), results: [result('a', 'pass')], startResult: 'success', held })).toMatchObject({ verdict: 'fail', own: 'pass', reason: expect.stringContaining(held.url) });
    expect(judge({ trigger: 'candidate', planned: gating('a'), results: [result('a', 'infra')], startResult: 'success', held })).toMatchObject({ verdict: 'fail', own: 'infra-only' });
    expect(judge({ trigger: 'candidate', planned: gating('a'), results: [result('a', 'pass')], startResult: 'success', held: null }).verdict).toBe('pass');
  });
});

/**
 * GitHub's issues in the harness, as `verdict` sees them through `gh api`: open issues listed
 * (paginated), one filed, one edited.
 */
const issueWorld = (issues = []) => {
  const store = issues.map((i, n) => ({ number: n + 1, state: 'open', user: BOT, title: '', body: '', ...i, html_url: `https://github.com/${H}/issues/${i.number ?? n + 1}` }));
  const calls = [];
  const ok = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
  const gh = async (args, input) => {
    const c = describeCall(args, input);
    calls.push(c);
    if (c.method === 'GET' && c.path.startsWith(`repos/${H}/issues?`) && c.path.includes('state=open') && args.includes('--paginate')) return ok([store.filter((i) => i.state === 'open')]);
    if (c.method === 'POST' && c.path === `repos/${H}/issues`) {
      const number = Math.max(0, ...store.map((i) => i.number)) + 1;
      const issue = { number, state: 'open', user: BOT, ...c.body, html_url: `https://github.com/${H}/issues/${number}` };
      store.push(issue);
      return ok(issue);
    }
    const m = c.path?.match(new RegExp(`^repos/${H}/issues/(\\d+)$`));
    if (c.method === 'PATCH' && m) {
      const issue = store.find((i) => i.number === Number(m[1]));
      Object.assign(issue, c.body);
      return ok(issue);
    }
    return { status: 1, stdout: '', stderr: `no route for ${c.key}` };
  };
  return { gh, calls, store, writes: () => calls.filter((c) => c.method !== 'GET'), open: () => store.filter((i) => i.state === 'open') };
};

const candidateRun = (over = {}) => ({
  trigger: 'candidate', release: RELEASE, candidateSha: SHA, startResult: 'success', run: run(), planned: gating('a', 'b'), results: [result('a', 'pass'), result('b', 'pass')], ...over,
});
const kept = (scenario, message) => result(scenario, 'fail', {
  repository: `kanon-e2e/e2e-${scenario}-39117109753-1`, repositoryAction: 'kept', firstFailure: { phase: 2, segment: 'act', index: 3, verb: 'expect.run', message },
});

describe('attest(): each planned scenario\'s result as the run\'s jobs list records it (#24, R3)', () => {
  it('takes the result the scenario\'s finalizing `act` job recorded, over what any artifact says', () => {
    expect(attest(free('a', 'b', 'c'), [result('a', 'pass'), result('b', 'pass')], [actOf('a', 'pass'), actOf('b', 'fail'), actOf('c', 'infra', { phase: 2 })]).map((r) => [r.scenario, r.result]))
      .toEqual([['a', 'pass'], ['b', 'fail'], ['c', 'infra']]);
  });

  it('keeps the artifact\'s details only when it agrees with the jobs list', () => {
    const a = result('a', 'fail', { firstFailure: { message: 'x' } });
    expect(attest(free('a'), [a], [actOf('a', 'fail')])).toEqual([a]);
    expect(attest(free('a'), [result('a', 'pass', { firstFailure: null })], [actOf('a', 'fail')])).toEqual([{ schema: 'kanon-e2e-result/v1', scenario: 'a', result: 'fail' }]);
  });

  it('a `pass` with no recorded result, or one R3 holds back, reads `unconfirmed`, never `pass`', () => {
    expect(attest(free('a'), [result('a', 'pass')], [])).toEqual([{ schema: 'kanon-e2e-result/v1', scenario: 'a', result: 'unconfirmed', unconfirmed: expect.stringMatching(/no `act` job/) }]);
    expect(attest(free('a'), [result('a', 'pass')], [actOf('a', 'pass', { conclusion: 'failure' })])[0]).toMatchObject({ result: 'unconfirmed', unconfirmed: expect.stringMatching(/concluded failure/) });
    expect(attest(free('a'), [result('a', 'pass')], null)[0]).toMatchObject({ result: 'unconfirmed', unconfirmed: expect.stringMatching(/jobs list/) });
  });

  it('an artifact\'s `fail` or `infra` with no recorded result stands: it can only hold a scenario back', () => {
    expect(attest(free('a', 'b'), [result('a', 'fail'), result('b', 'infra')], []).map((r) => r.result)).toEqual(['fail', 'infra']);
  });

  it('never takes `unconfirmed` from an artifact, and reads nothing for an unplanned scenario', () => {
    expect(attest(free('a'), [result('a', 'unconfirmed', { unconfirmed: '@someone' }), result('x', 'pass')], [])).toEqual([]);
  });

  it('`judge` reads an `unconfirmed` scenario as no pass: `infra-only`, unless another failed', () => {
    const v = judge({ planned: free('a', 'b'), results: attest(free('a', 'b'), [result('a', 'pass'), result('b', 'pass')], [actOf('b', 'pass')]), startResult: 'skipped' });
    expect(v).toMatchObject({ verdict: 'infra-only', scenarios: [{ id: 'a', result: 'unconfirmed', unconfirmed: expect.any(String) }, { id: 'b', result: 'pass' }] });
  });
});

describe('verdict on a candidate\'s run: the red issue (§8.3)', () => {
  it('files one issue, `e2e: candidate-vX.Y.Z is red`, listing each gating scenario that didn\'t pass: its result, first failure, kept repository and the run', async () => {
    const w = issueWorld();
    const doc = await give(candidateRun({ planned: [...gating('a', 'b', 'c'), ...free('d')], results: [kept('a', 'expected `conclusion` success, got failure'), result('b', 'infra'), result('c', 'pass'), result('d', 'fail')] }), { gh: w.gh });
    expect(doc.verdict).toBe('fail');
    expect(w.store).toHaveLength(1);
    const [issue] = w.store;
    expect(issue.title).toBe(redTitle(RELEASE));
    expect(issue.title).toBe('e2e: candidate-v0.41.0 is red');
    expect(issue.body).toContain('`a`');
    expect(issue.body).toContain('expect.run');
    expect(issue.body).toContain('expected \'conclusion\' success, got failure');
    expect(issue.body).toContain('https://github.com/kanon-e2e/e2e-a-39117109753-1');
    expect(issue.body).toMatch(/`b`[^\n]*infra/);
    expect(issue.body).toContain(run().url);
    // A passing gating scenario and a `gate: false` one aren't listed.
    expect(issue.body).not.toMatch(/`c`|`d`/);
    expect(doc.redIssue).toBe(issue.html_url);
  });

  it('writes a first failure as inert text: no mention, no link, no table break', async () => {
    const w = issueWorld();
    await give(candidateRun({ planned: gating('a'), results: [kept('a', 'ping @yedeya, see #1 | `x`\nnext line')] }), { gh: w.gh });
    const line = w.store[0].body.split('\n').find((l) => l.includes('ping'));
    expect(line).toContain('`ping @yedeya, see #1 | \'x\' next line`');
  });

  it('links a kept repository only when the result says `kept` and names one of the test organisation\'s', async () => {
    const w = issueWorld();
    await give(candidateRun({ planned: gating('a', 'b'), results: [{ ...kept('a', 'x'), repositoryAction: 'deleted' }, { ...kept('b', 'y'), repository: 'evil/x' }] }), { gh: w.gh });
    expect(w.store[0].body).not.toMatch(/github\.com\/(kanon-e2e\/e2e-|evil)/);
  });

  it('finds the issue by the harness\'s marker in its body, never by its title, and reads only issues opened by github-actions[bot]', async () => {
    const w = issueWorld();
    await give(candidateRun({ results: [result('a', 'fail')] }), { gh: w.gh });
    const filed = w.store[0];
    const decoys = issueWorld([
      { number: 1, title: redTitle(RELEASE), body: 'no marker here' },
      { number: 2, title: 'something else', body: filed.body, user: { login: 'someone', type: 'User' } },
      { number: 3, title: 'something else', body: filed.body.replace(RELEASE, 'candidate-v0.40.0') },
      { number: 4, title: 'a pull request', body: filed.body, pull_request: { url: 'x' } },
    ]);
    const doc = await give(candidateRun({ results: [result('a', 'fail')] }), { gh: decoys.gh });
    expect(decoys.store).toHaveLength(5);
    expect(doc.redIssue).toBe(`https://github.com/${H}/issues/5`);
    // Retitled by a person, it is still the candidate's issue.
    const retitled = issueWorld([{ number: 9, title: 'renamed', body: filed.body }]);
    expect((await give(candidateRun({ results: [result('a', 'fail')] }), { gh: retitled.gh })).redIssue).toBe(`https://github.com/${H}/issues/9`);
    expect(retitled.store).toHaveLength(1);
  });

  it('a later run of the same candidate edits that issue, adding its own run, rather than filing another', async () => {
    const w = issueWorld();
    await give(candidateRun({ results: [result('a', 'infra')] }), { gh: w.gh });
    await give(candidateRun({ run: run('39117109999', '2'), results: [result('a', 'pass'), result('b', 'missing')] }), { gh: w.gh });
    expect(w.store).toHaveLength(1);
    expect(w.store[0].body).toContain(run().url);
    expect(w.store[0].body).toContain(run('39117109999').url);
    expect(w.store[0].body).toMatch(/39117109999[^\n]*attempt 2/);
  });

  it('an `infra`-only red issue closes on a green run', async () => {
    const w = issueWorld();
    await give(candidateRun({ results: [result('a', 'infra')] }), { gh: w.gh });
    await give(candidateRun({ run: run('2'), startResult: 'success', results: [result('a', 'infra'), result('b', 'pass')] }), { gh: w.gh });
    expect(w.open()).toHaveLength(1);
    const doc = await give(candidateRun({ run: run('3') }), { gh: w.gh });
    expect(doc.verdict).toBe('pass');
    expect(w.store[0]).toMatchObject({ state: 'closed', state_reason: 'completed' });
    expect(w.store[0].body).toContain(run('3').url);
    expect(doc.redIssue).toBe(w.store[0].html_url);
  });

  it('a green run never closes a red issue that holds a `fail`: a person closes it, with the cause', async () => {
    const w = issueWorld();
    await give(candidateRun({ results: [result('a', 'fail')] }), { gh: w.gh });
    // An `infra`-only run after it doesn't forget the `fail`.
    await give(candidateRun({ run: run('2'), results: [result('a', 'infra'), result('b', 'pass')] }), { gh: w.gh });
    await give(candidateRun({ run: run('3') }), { gh: w.gh });
    expect(w.store).toHaveLength(1);
    expect(w.store[0].state).toBe('open');
    expect(w.writes().some((c) => c.body?.state === 'closed')).toBe(false);
  });

  it('a marker quoted from a result, or in another issue\'s text, never passes for the harness\'s: only the body\'s first line identifies an issue', async () => {
    const w = issueWorld([
      // An issue of github-actions[bot]'s that quotes the candidate's red marker below its first line.
      { number: 1, title: 'a quote', body: `Quoted from a log:\n\`<!-- kanon-e2e-red {"candidate":"${RELEASE}","failSeen":false} -->\`` },
    ]);
    // A failure whose message quotes the Reporter's marker, and another candidate's red marker.
    const quoted = '<!-- kanon-e2e-reporter-cannot-post {} --> and <!-- kanon-e2e-red {"candidate":"candidate-v0.40.0","failSeen":false} -->';
    await give(candidateRun({ results: [kept('a', quoted), result('b', 'pass')] }), { gh: w.gh });
    expect(w.store).toHaveLength(2);
    const red = w.store[1];
    expect(red.body).toContain('kanon-e2e-reporter-cannot-post');
    // A run whose `start` succeeded closes no red issue as if it were the Reporter's.
    const doc = await give(candidateRun({ run: run('2') }), { gh: w.gh });
    expect(doc).toMatchObject({ verdict: 'fail', redIssue: red.html_url, reporterIssue: null });
    expect(red.state).toBe('open');
    expect(w.store[0]).toMatchObject({ state: 'open', body: expect.not.stringContaining(run('2').url) });
    expect((await give(candidateRun({ run: run('3') }), { gh: w.gh })).verdict).toBe('fail');
    expect(w.open()).toHaveLength(2);
    // Another candidate's run doesn't take this one's red issue, by the marker its text quotes.
    const other = await give(candidateRun({ release: 'candidate-v0.40.0', run: run('4') }), { gh: w.gh });
    expect(other).toMatchObject({ verdict: 'pass', redIssue: null });
    expect(red.body).not.toContain(run('4').url);
  });

  it('a green run for a candidate whose red issue still holds an open `fail` answers `fail`', async () => {
    const w = issueWorld();
    await give(candidateRun({ results: [result('a', 'fail')] }), { gh: w.gh });
    const doc = await give(candidateRun({ run: run('2') }), { gh: w.gh });
    expect(doc).toMatchObject({ verdict: 'fail', reason: expect.stringContaining(w.store[0].html_url), redIssue: w.store[0].html_url });
    expect(w.store[0].body).toContain(run('2').url);
    // Once a person closed it, the next green run is green.
    w.store[0].state = 'closed';
    expect((await give(candidateRun({ run: run('3') }), { gh: w.gh })).verdict).toBe('pass');
  });

  it('when it can\'t read the issues, it can\'t answer `pass`', async () => {
    const gh = async () => ({ status: 1, stdout: '', stderr: 'HTTP 502' });
    expect(await give(candidateRun(), { gh })).toMatchObject({ verdict: 'infra-only', reason: expect.stringMatching(/red issue/) });
    expect((await give(candidateRun({ results: [result('a', 'fail')] }), { gh })).verdict).toBe('fail');
  });

  it('only a candidate\'s run files, edits, closes or reads an issue: a nightly or a dispatch writes only its summary', async () => {
    for (const trigger of ['nightly', 'dispatch']) {
      const w = issueWorld([{ number: 1, body: '' }]);
      const doc = await give({ ...candidateRun({ results: [result('a', 'fail')] }), trigger, candidateSha: '', startResult: 'skipped' }, { gh: w.gh });
      expect(doc.verdict, trigger).toBe('fail');
      expect(w.calls, trigger).toEqual([]);
      expect(doc.redIssue, trigger).toBeNull();
    }
  });

  it('records `trigger`, `release`, `candidateSha`, the run\'s id and attempt, each scenario\'s `gate`, and the red issue', async () => {
    const w = issueWorld();
    const doc = await give(candidateRun({ planned: [...gating('a'), ...free('b')], results: [result('a', 'fail'), result('b', 'pass')] }), { gh: w.gh });
    expect(doc).toMatchObject({
      schema: 'kanon-e2e-verdict/v1', verdict: 'fail', trigger: 'candidate', release: RELEASE, candidateSha: SHA,
      run: { id: '39117109753', attempt: '1', url: run().url }, scenarios: [{ id: 'a', gate: true }, { id: 'b', gate: false }], redIssue: w.store[0].html_url,
    });
    const off = await give({ trigger: 'dispatch', release: 'v0.40.2', candidateSha: '', startResult: 'skipped', run: run(), planned: free('a'), results: [result('a', 'pass')] }, { gh: w.gh });
    expect(off).toMatchObject({ trigger: 'dispatch', release: 'v0.40.2', candidateSha: '', redIssue: null, reporterIssue: null });
  });
});

describe('verdict: the `the Reporter can\'t post` issue', () => {
  it('with `start` failed, files it, and the run still fails', async () => {
    const w = issueWorld();
    const doc = await give(candidateRun({ startResult: 'failure', results: [] }), { gh: w.gh });
    expect(doc.verdict).toBe('infra-only');
    const filed = w.store.find((i) => i.title === REPORTER_TITLE);
    expect(REPORTER_TITLE).toBe('e2e: the Reporter can\'t post');
    expect(filed.body).toContain(run().url);
    expect(doc.reporterIssue).toBe(filed.html_url);
  });

  it('while one is open, a later failed `start` edits it rather than filing another; the next run whose `start` succeeded closes it', async () => {
    const w = issueWorld();
    await give(candidateRun({ startResult: 'failure', results: [] }), { gh: w.gh });
    await give(candidateRun({ run: run('2'), startResult: 'failure', results: [] }), { gh: w.gh });
    const reporter = () => w.store.filter((i) => i.title === REPORTER_TITLE);
    expect(reporter()).toHaveLength(1);
    expect(reporter()[0].body).toContain(run('2').url);
    expect(reporter()[0].state).toBe('open');
    await give(candidateRun({ run: run('3'), results: [result('a', 'fail')] }), { gh: w.gh });
    expect(reporter()[0]).toMatchObject({ state: 'closed', state_reason: 'completed' });
    expect(reporter()[0].body).toContain(run('3').url);
  });

  it('is found by its marker, among github-actions[bot]\'s issues only', async () => {
    const w = issueWorld([{ number: 1, title: REPORTER_TITLE, body: 'no marker' }]);
    await give(candidateRun({ startResult: 'failure', results: [] }), { gh: w.gh });
    expect(w.store.filter((i) => i.title === REPORTER_TITLE)).toHaveLength(2);
    expect(w.store[0].state).toBe('open');
  });
});

describe('verdict\'s command: verdict.json and the exit status', () => {
  /**
   * What `verdict`'s `download-artifact` step (v8.0.2, `pattern:`, no `merge-multiple`) leaves in
   * `results`: each matched artifact in a directory of its own name, except when the pattern
   * matched exactly one, which lands in `results` itself (its `src/download-artifact.ts`:
   * `artifacts.length === 1 ? resolvedPath : path.join(resolvedPath, artifact.name)`).
   */
  const download = (results, artifacts) => {
    for (const a of artifacts) writeTree(artifacts.length === 1 ? results : join(results, a.name), a.files);
  };

  /** The artifact an `act` job uploads for a result: `kanon-e2e-result-<scenario>`, holding `result.json`. */
  const uploaded = (r) => ({ name: `kanon-e2e-result-${r.scenario}`, files: { 'result.json': JSON.stringify(r) } });

  /** A `gh` on PATH serving the harness's issues from ISSUES_FILE, as `issueWorld` does. */
  const fakeGh = (dir) => {
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const store = JSON.parse(fs.readFileSync(process.env.ISSUES_FILE, 'utf8'));
const save = () => fs.writeFileSync(process.env.ISSUES_FILE, JSON.stringify(store));
const i = args.indexOf('-X');
const method = i >= 0 ? args[i + 1] : 'GET';
const path = args.filter((a, j) => j > 0 && !a.startsWith('-') && args[j - 1] !== '-X' && args[j - 1] !== '--input').pop();
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
if (method === 'GET' && path.startsWith('repos/${H}/issues?')) { process.stdout.write(JSON.stringify([store.filter((x) => x.state === 'open')])); process.exit(0); }
if (method === 'GET' && path === 'repos/${H}/actions/runs/39117109753/attempts/1/jobs?per_page=100') { if (!process.env.JOBS_FILE) { process.stderr.write('HTTP 404'); process.exit(1); } process.stdout.write(JSON.stringify([{ jobs: JSON.parse(fs.readFileSync(process.env.JOBS_FILE, 'utf8')) }])); process.exit(0); }
if (method === 'POST') { const n = store.length + 1; const x = { number: n, state: 'open', user: { login: 'github-actions[bot]', type: 'Bot' }, ...body, html_url: 'https://github.com/${H}/issues/' + n }; store.push(x); save(); process.stdout.write(JSON.stringify(x)); process.exit(0); }
if (method === 'PATCH') { const x = store.find((y) => y.number === Number(path.split('/').pop())); Object.assign(x, body); save(); process.stdout.write(JSON.stringify(x)); process.exit(0); }
process.stderr.write('no route'); process.exit(1);
`);
    chmodSync(gh, 0o755);
  };

  const cli = (env) => {
    const dir = tempDir('verdict-');
    const results = join(dir, 'results');
    mkdirSync(results);
    download(results, env.artifacts ?? (env.results ?? []).map(uploaded));
    mkdirSync(join(dir, 'bin'));
    fakeGh(join(dir, 'bin'));
    const issues = env.issues ?? join(dir, 'issues.json');
    if (!env.issues) writeFileSync(issues, '[]');
    const output = join(dir, 'output');
    writeFileSync(output, '');
    // The run's jobs list: by default, each result's own `act` job recorded it, as an honest run's does.
    const jobs = env.jobs !== undefined ? env.jobs : (env.results ?? []).filter((r) => ['pass', 'fail', 'infra'].includes(r.result)).map((r) => actOf(r.scenario, r.result));
    if (jobs) writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobs));
    const planned = env.planned.map((p) => (typeof p === 'string' ? { id: p, gate: false } : p)).map((p) => ({ ...p, apps: [], claude: 'none' }));
    const r = spawnSync(process.execPath, ['runner/verdict.mjs'], {
      env: {
        ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, ISSUES_FILE: issues, ...(jobs ? { JOBS_FILE: join(dir, 'jobs.json') } : {}), START_RESULT: env.start ?? 'success', SCENARIOS: JSON.stringify(planned), RESULTS_DIR: results, OUT: join(dir, 'out'), GITHUB_OUTPUT: output,
        TRIGGER: env.trigger ?? 'dispatch', RELEASE: env.release ?? 'v0.40.2', CANDIDATE_SHA: env.sha ?? '', GITHUB_RUN_ID: '39117109753', GITHUB_RUN_ATTEMPT: '1', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: H,
      },
      encoding: 'utf8',
    });
    const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { status: r.status, verdict: JSON.parse(readFileSync(join(dir, 'out', 'verdict.json'), 'utf8')), issues, outputs };
  };

  it('reads a result in either layout `download-artifact` leaves: one match, in `results` itself; several, one directory each', () => {
    // One match: every run of a single scenario, and a run where only one scenario's `act` job uploaded.
    expect(cli({ planned: ['a'], results: [result('a', 'fail')] })).toMatchObject({ status: 1, verdict: { verdict: 'fail', scenarios: [{ id: 'a', result: 'fail' }] } });
    expect(cli({ planned: ['a'], results: [result('a', 'pass')] })).toMatchObject({ status: 0, verdict: { verdict: 'pass' } });
    expect(cli({ planned: ['a', 'b'], results: [result('b', 'fail')] })).toMatchObject({ status: 1, verdict: { verdict: 'fail', scenarios: [{ id: 'a', result: 'missing' }, { id: 'b', result: 'fail' }] } });
    // Several matches.
    expect(cli({ planned: ['a', 'b'], results: [result('a', 'pass'), result('b', 'fail')] })).toMatchObject({ status: 1, verdict: { verdict: 'fail', scenarios: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'fail' }] } });
    expect(cli({ planned: ['a', 'b'], results: [result('a', 'pass'), result('b', 'pass')] })).toMatchObject({ status: 0, verdict: { verdict: 'pass' } });
  });

  it('counts a result only from where an `act` job puts it: its own artifact\'s `result.json`, for its own scenario', () => {
    const pass = (scenario) => JSON.stringify(result(scenario, 'pass'));
    const ids = (v) => v.scenarios.map(({ id, result: r }) => ({ id, result: r }));
    // `a`'s own `act` job recorded the pass its artifact reads; no job recorded one for `b` or `c`.
    const jobs = [actOf('a', 'pass')];
    // Several matches: an artifact's result counts only for the scenario its name gives.
    expect(ids(cli({ planned: ['a', 'b'], jobs: [], artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': pass('b') } }, { name: 'kanon-e2e-result-x', files: { 'result.json': pass('a') } }] }).verdict)).toEqual([{ id: 'a', result: 'missing' }, { id: 'b', result: 'missing' }]);
    // A result nested deeper in an artifact, or under another name, is not one.
    expect(ids(cli({ planned: ['a', 'b'], jobs, artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': pass('a'), 'kanon-e2e-result-b/result.json': pass('b') } }, { name: 'kanon-e2e-result-c', files: { 'result.json': pass('c') } }] }).verdict)).toEqual([{ id: 'a', result: 'pass' }, { id: 'b', result: 'missing' }]);
    // One match: the one artifact gives one result, its `result.json`, and nothing else it holds counts.
    expect(cli({ planned: ['a', 'b'], jobs, artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': pass('a'), 'kanon-e2e-result-b/result.json': pass('b') } }] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only', scenarios: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'missing' }] } });
    expect(ids(cli({ planned: ['a', 'b'], jobs: [], artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': 'not json', 'kanon-e2e-result-b/result.json': pass('b') } }] }).verdict)).toEqual([{ id: 'a', result: 'missing' }, { id: 'b', result: 'missing' }]);
    // One match, read as a result for an unplanned scenario: no planned scenario reads it.
    expect(cli({ planned: ['a'], results: [result('x', 'pass')] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only', scenarios: [{ id: 'a', result: 'missing' }] } });
  });

  it('a `pass` an artifact claims counts only when the scenario\'s own `act` job recorded it in the run\'s jobs list (#24, R3)', () => {
    const planted = [uploaded(result('a', 'pass')), uploaded(result('b', 'pass'))];
    // `a`'s act job recorded `fail`, and no act job of `b`'s recorded anything: both artifacts were planted.
    const forged = cli({ planned: ['a', 'b'], jobs: [actOf('a', 'fail'), { name: actJob(1, 'b'), conclusion: 'success', steps: [] }], artifacts: planted });
    expect(forged).toMatchObject({ status: 1, verdict: { verdict: 'fail', scenarios: [{ id: 'a', result: 'fail' }, { id: 'b', result: 'unconfirmed' }] } });
    // `b` alone: nothing failed, and nothing confirmed its pass.
    expect(cli({ planned: ['b'], jobs: [], results: [result('b', 'pass')] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only', scenarios: [{ id: 'b', result: 'unconfirmed' }] } });
    // A planted `fail` over a recorded `pass` changes nothing either: the jobs list names the result.
    expect(cli({ planned: ['a'], jobs: [actOf('a', 'pass')], results: [result('a', 'fail')] })).toMatchObject({ status: 0, verdict: { verdict: 'pass' } });
  });

  it('can\'t answer `pass` when it can\'t read the run\'s jobs list, and says why', () => {
    const r = cli({ planned: ['a', 'b'], jobs: null, results: [result('a', 'pass'), result('b', 'fail')] });
    expect(r).toMatchObject({ status: 1, verdict: { verdict: 'fail', scenarios: [{ id: 'a', result: 'unconfirmed', unconfirmed: expect.stringMatching(/jobs list/) }, { id: 'b', result: 'fail' }] } });
    expect(cli({ planned: ['a'], jobs: null, results: [result('a', 'pass')] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only' } });
  });

  it('the download step is the one those layouts are: a `pattern:` for `kanon-e2e-result-*`, with no `name:` and no `merge-multiple`', () => {
    const step = readWorkflows()['e2e.yml'].jobs.verdict.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(step.uses).toMatch(/@9000827ccba6bdab643e8b6fd33ac0654aef8333$/);
    expect(step.with).toEqual({ pattern: 'kanon-e2e-result-*', path: '${{ runner.temp }}/results' });
  });

  it('exits 0 on pass, writing verdict.json', () => {
    expect(cli({ planned: ['a'], results: [result('a', 'pass')] })).toMatchObject({ status: 0, verdict: { schema: 'kanon-e2e-verdict/v1', verdict: 'pass' } });
  });

  it('hands `report` the verdict and the red issue as its step outputs, which `report` reads in place of an artifact (#24)', () => {
    expect(cli({ planned: ['a'], results: [result('a', 'pass')] }).outputs).toEqual({ verdict: 'pass', 'red-issue': '' });
    const red = cli({ trigger: 'candidate', release: RELEASE, sha: SHA, planned: gating('a'), results: [result('a', 'fail')] });
    expect(red.outputs).toEqual({ verdict: 'fail', 'red-issue': red.verdict.redIssue });
    expect(red.verdict.redIssue).toMatch(/\/issues\/\d+$/);
  });

  it('exits non-zero on fail and on infra-only, after writing verdict.json', () => {
    expect(cli({ planned: ['a'], results: [result('a', 'fail')] })).toMatchObject({ status: 1, verdict: { verdict: 'fail' } });
    expect(cli({ planned: ['a'], results: [result('a', 'infra')] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only' } });
  });

  it('with `start` failed and no repository created, still runs, files the Reporter\'s issue and exits non-zero', () => {
    const r = cli({ trigger: 'candidate', release: RELEASE, sha: SHA, planned: gating('a'), results: [], start: 'failure' });
    expect(r).toMatchObject({ status: 1, verdict: { verdict: 'infra-only', reporterIssue: expect.stringMatching(/\/issues\/\d+$/) } });
    expect(JSON.parse(readFileSync(r.issues, 'utf8')).map((i) => i.title)).toContain(REPORTER_TITLE);
  });

  it('a green run while the candidate\'s red issue holds an open `fail`: `fail`, so its `verdict` job, and its run, conclude `failure`', () => {
    const red = cli({ trigger: 'candidate', release: RELEASE, sha: SHA, planned: gating('a'), results: [result('a', 'fail')] });
    expect(red).toMatchObject({ status: 1, verdict: { verdict: 'fail' } });
    const green = cli({ trigger: 'candidate', release: RELEASE, sha: SHA, planned: gating('a'), results: [result('a', 'pass')], issues: red.issues });
    expect(green).toMatchObject({ status: 1, verdict: { verdict: 'fail', candidateSha: SHA, redIssue: red.verdict.redIssue } });
  });
});

describe('report: the check run\'s conclusion and summary from `verdict`\'s outputs', () => {
  const e2e = readWorkflows()['e2e.yml'];
  const report = e2e.jobs.report;
  const read = report.steps.find((s) => s.id === 'verdict');
  const complete = report.steps.find((s) => s.name === 'Complete the check run');

  /** Runs the read step's script on what `verdict`'s outputs carried: empty when it didn't run. */
  const conclude = ({ verdict = '', redIssue = '' } = {}) => {
    const dir = tempDir('report-');
    const output = join(dir, 'output');
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-c', read.run], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, VERDICT: verdict, ISSUE: redIssue }, stdio: 'ignore' });
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  };

  /** Runs the complete step's script with a `gh` on PATH that logs its calls and fails the first `failures`. */
  const post = (env, failures = 0) => {
    const dir = tempDir('report-post-');
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const n = fs.readFileSync(process.env.GH_LOG, 'utf8').trim().split('\\n').length;
if (n <= Number(process.env.FAILURES)) { process.stderr.write('HTTP 502'); process.exit(1); }
`);
    writeFileSync(join(dir, 'sleep'), '#!/bin/sh\n');
    chmodSync(join(dir, 'gh'), 0o755);
    chmodSync(join(dir, 'sleep'), 0o755);
    const log = join(dir, 'log');
    const r = spawnSync('bash', ['-e', '-c', complete.run], {
      env: { PATH: `${dir}:${process.env.PATH}`, GH_LOG: log, FAILURES: String(failures), GITHUB_RUN_ATTEMPT: '1', ID: '117645071658', RELEASE, RUN_URL: run().url, ...env },
      encoding: 'utf8',
    });
    let calls = [];
    try {
      calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    } catch {}
    return { status: r.status, calls };
  };
  const field = (args, name) => args[args.indexOf(args.find((a) => a.startsWith(`${name}=`)))].slice(name.length + 1);

  it('success for pass, failure for fail, neutral for infra-only', () => {
    expect(conclude({ verdict: 'pass' }).conclusion).toBe('success');
    expect(conclude({ verdict: 'fail' }).conclusion).toBe('failure');
    expect(conclude({ verdict: 'infra-only' }).conclusion).toBe('neutral');
  });

  it('neutral when `verdict` gave no verdict (it didn\'t run, or stopped before its output), or one that isn\'t a verdict', () => {
    expect(conclude()).toEqual({ conclusion: 'neutral', verdict: 'none', issue: '' });
    expect(conclude({ verdict: 'PASS' }).conclusion).toBe('neutral');
    expect(conclude({ verdict: 'pass\nconclusion=success' })).toEqual({ conclusion: 'neutral', verdict: 'unreadable', issue: '' });
  });

  it('reads the verdict from the `verdict` job\'s outputs, never from an artifact: a `kanon` job\'s code may upload one under any name, but can\'t set another job\'s outputs (#24)', () => {
    expect(report.steps.filter((s) => s.uses?.startsWith('actions/download-artifact@'))).toEqual([]);
    expect(read.env).toEqual({ VERDICT: '${{ needs.verdict.outputs.verdict }}', ISSUE: '${{ needs.verdict.outputs.red-issue }}' });
    const give = e2e.jobs.verdict.steps.find((s) => s.run === 'node runner/verdict.mjs');
    expect(e2e.jobs.verdict.outputs).toEqual({ verdict: `\${{ steps.${give.id}.outputs.verdict }}`, 'red-issue': `\${{ steps.${give.id}.outputs.red-issue }}` });
  });

  it('`verdict.json` stays an artifact for people to read, and its upload replaces one planted under its name (#24)', () => {
    const upload = e2e.jobs.verdict.steps.find((s) => s.name === 'Upload verdict.json');
    expect(upload.with).toMatchObject({ name: 'verdict', overwrite: true });
  });

  it('takes the red issue only as an issue of this repository\'s', () => {
    expect(conclude({ verdict: 'fail', redIssue: `https://github.com/${H}/issues/41` }).issue).toBe(`https://github.com/${H}/issues/41`);
    for (const forged of [`https://github.com/${H}/issues/41 [x](https://evil)`, 'https://evil.example/issues/1', `https://github.com/${H}/pull/3`, `https://github.com/${H}/issues/41\nconclusion=success`]) {
      expect(conclude({ verdict: 'fail', redIssue: forged }).issue, String(forged)).toBe('');
    }
  });

  it('posts `failure` for a red verdict, completing the check run, its summary linking this run and the red issue', () => {
    const issue = `https://github.com/${H}/issues/41`;
    const { status, calls } = post({ CONCLUSION: 'failure', VERDICT: 'fail', ISSUE: issue });
    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    const [args] = calls;
    expect(args).toEqual(expect.arrayContaining(['-X', 'PATCH', 'repos/yedeya-labs/kanon/check-runs/117645071658', 'status=completed', 'conclusion=failure']));
    const summary = field(args, 'output[summary]');
    expect(summary).toContain(run().url);
    expect(summary).toContain(issue);
    expect(field(post({ CONCLUSION: 'success', VERDICT: 'pass', ISSUE: '' }).calls[0], 'output[summary]')).not.toMatch(/issues\//);
  });

  it('never leaves the check run `in_progress`: `report` runs whatever `verdict` did, no step of it is skipped, and a 5xx is retried', () => {
    expect(report.if).toBe("${{ always() && needs.start.result == 'success' }}");
    expect(report.steps.filter((s) => s.if !== undefined)).toEqual([]);
    const retried = post({ CONCLUSION: 'failure', VERDICT: 'fail', ISSUE: '' }, 2);
    expect(retried.status).toBe(0);
    expect(retried.calls).toHaveLength(3);
    expect(post({ CONCLUSION: 'failure', VERDICT: 'fail', ISSUE: '' }, 3).status).not.toBe(0);
  });
});

describe('what Kanon\'s gate reads (§8.2)', () => {
  const e2e = readWorkflows()['e2e.yml'];
  const create = e2e.jobs.start.steps.find((s) => s.id === 'create');
  const docs = readFileSync('docs/jobs.md', 'utf8');

  it('`start`\'s name carries the candidate\'s tag and its full commit, from `plan`', () => {
    expect(e2e.jobs.start.name).toBe('start (the Reporter\'s check run: ${{ needs.plan.outputs.release }} at ${{ needs.plan.outputs.candidate-sha }})');
  });

  it('the check run: `kanon-e2e`, by the Reporter, on the candidate\'s commit, `external_id` `<run id>-<run attempt>`, `details_url` the run', () => {
    expect(create.run).toMatch(/repos\/yedeya-labs\/kanon\/check-runs -f name=kanon-e2e -f head_sha="\$SHA"/);
    expect(create.env.SHA).toBe('${{ needs.plan.outputs.candidate-sha }}');
    expect(create.run).toContain('-f external_id="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
    expect(create.run).toContain('-f details_url="$RUN_URL"');
    expect(e2e.jobs.start.steps.find((s) => s.id === 'reporter').with['app-id']).toBe('${{ secrets.REPORTER_APP_ID }}');
  });

  it('docs/jobs.md states the `external_id`\'s form and the jobs list the gate reads it with', () => {
    expect(docs).toMatch(/^## What Kanon's gate reads$/m);
    expect(docs).toContain('`<run id>-<run attempt>`');
    expect(docs).toContain('GET repos/kanon-e2e/harness/actions/runs/<run id>/attempts/<attempt>/jobs');
    expect(docs).toContain('5349415');
  });
});
