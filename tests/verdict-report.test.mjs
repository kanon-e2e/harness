import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judge } from '../runner/verdict.mjs';
import { tempDir, writeTree } from './helpers/stubs.mjs';
import { readWorkflows } from './helpers/workflows.mjs';

/**
 * `verdict` and `report`, as far as harness #16 builds them (Kanon plan 0012 §5.2): `verdict`'s
 * exit status, and `report`'s mapping from `verdict.json` to the check run's conclusion. The
 * verdict module proper, the gate's `gate: true` reading and the issues `verdict` files are E8's.
 */

const result = (scenario, r) => ({ schema: 'kanon-e2e-result/v1', scenario, result: r });

describe('verdict: pass, fail or infra-only, and its exit status', () => {
  it('passes only when every planned scenario passed', () => {
    expect(judge({ planned: ['a', 'b'], results: [result('a', 'pass'), result('b', 'pass')], startResult: 'success' }).verdict).toBe('pass');
  });

  it('answers fail when any scenario failed', () => {
    expect(judge({ planned: ['a', 'b'], results: [result('a', 'fail'), result('b', 'infra')], startResult: 'success' }).verdict).toBe('fail');
  });

  it('answers infra-only when nothing failed but something was infra or has no result; never pass', () => {
    expect(judge({ planned: ['a', 'b'], results: [result('a', 'pass'), result('b', 'infra')], startResult: 'skipped' }).verdict).toBe('infra-only');
    expect(judge({ planned: ['a', 'b'], results: [result('a', 'pass')], startResult: 'skipped' })).toMatchObject({ verdict: 'infra-only', scenarios: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'missing' }] });
  });

  it('with `start` failed, answers infra-only: the Reporter can\'t post', () => {
    expect(judge({ planned: ['a'], results: [], startResult: 'failure' })).toMatchObject({ verdict: 'infra-only', reason: expect.stringMatching(/Reporter/) });
  });

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

  const cli = (env) => {
    const dir = tempDir('verdict-');
    const results = join(dir, 'results');
    mkdirSync(results);
    download(results, env.artifacts ?? (env.results ?? []).map(uploaded));
    const r = spawnSync(process.execPath, ['runner/verdict.mjs'], {
      env: { ...process.env, START_RESULT: env.start ?? 'success', SCENARIOS: JSON.stringify(env.planned.map((id) => ({ id, apps: [], claude: 'none' }))), RESULTS_DIR: results, OUT: join(dir, 'out') },
      encoding: 'utf8',
    });
    return { status: r.status, verdict: JSON.parse(readFileSync(join(dir, 'out', 'verdict.json'), 'utf8')) };
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
    // Several matches: an artifact's result counts only for the scenario its name gives.
    expect(cli({ planned: ['a', 'b'], artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': pass('b') } }, { name: 'kanon-e2e-result-x', files: { 'result.json': pass('a') } }] }).verdict.scenarios).toEqual([{ id: 'a', result: 'missing' }, { id: 'b', result: 'missing' }]);
    // A result nested deeper in an artifact, or under another name, is not one.
    expect(cli({ planned: ['a', 'b'], artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': pass('a'), 'kanon-e2e-result-b/result.json': pass('b') } }, { name: 'kanon-e2e-result-c', files: { 'result.json': pass('c') } }] }).verdict.scenarios).toEqual([{ id: 'a', result: 'pass' }, { id: 'b', result: 'missing' }]);
    // One match: the one artifact gives one result, its `result.json`, and nothing else it holds counts.
    expect(cli({ planned: ['a', 'b'], artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': pass('a'), 'kanon-e2e-result-b/result.json': pass('b') } }] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only', scenarios: [{ id: 'a', result: 'pass' }, { id: 'b', result: 'missing' }] } });
    expect(cli({ planned: ['a', 'b'], artifacts: [{ name: 'kanon-e2e-result-a', files: { 'result.json': 'not json', 'kanon-e2e-result-b/result.json': pass('b') } }] }).verdict.scenarios).toEqual([{ id: 'a', result: 'missing' }, { id: 'b', result: 'missing' }]);
    // One match, read as a result for an unplanned scenario: no planned scenario reads it.
    expect(cli({ planned: ['a'], results: [result('x', 'pass')] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only', scenarios: [{ id: 'a', result: 'missing' }] } });
  });

  it('the download step is the one those layouts are: a `pattern:` for `kanon-e2e-result-*`, with no `name:` and no `merge-multiple`', () => {
    const step = readWorkflows()['e2e.yml'].jobs.verdict.steps.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(step.uses).toMatch(/@9000827ccba6bdab643e8b6fd33ac0654aef8333$/);
    expect(step.with).toEqual({ pattern: 'kanon-e2e-result-*', path: '${{ runner.temp }}/results' });
  });

  it('exits 0 on pass, writing verdict.json', () => {
    expect(cli({ planned: ['a'], results: [result('a', 'pass')] })).toMatchObject({ status: 0, verdict: { schema: 'kanon-e2e-verdict/v1', verdict: 'pass' } });
  });

  it('exits non-zero on fail and on infra-only, after writing verdict.json', () => {
    expect(cli({ planned: ['a'], results: [result('a', 'fail')] })).toMatchObject({ status: 1, verdict: { verdict: 'fail' } });
    expect(cli({ planned: ['a'], results: [result('a', 'infra')] })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only' } });
  });

  it('with `start` failed and no repository created, still runs and exits non-zero', () => {
    expect(cli({ planned: ['a'], results: [], start: 'failure' })).toMatchObject({ status: 1, verdict: { verdict: 'infra-only' } });
  });
});

describe('report: the check run\'s conclusion from verdict.json', () => {
  const step = readWorkflows()['e2e.yml'].jobs.report.steps.find((s) => s.id === 'verdict');

  /** Runs the step's script on what `Download verdict.json` left (or didn't). */
  const conclude = (verdict) => {
    const dir = tempDir('report-');
    if (verdict !== undefined) writeTree(dir, { 'verdict/verdict.json': typeof verdict === 'string' ? verdict : JSON.stringify(verdict) });
    const output = join(dir, 'output');
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-c', step.run], { env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: output }, stdio: 'ignore' });
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((l) => l.split('=')));
  };

  it('success for pass, failure for fail, neutral for infra-only', () => {
    expect(conclude({ verdict: 'pass' }).conclusion).toBe('success');
    expect(conclude({ verdict: 'fail' }).conclusion).toBe('failure');
    expect(conclude({ verdict: 'infra-only' }).conclusion).toBe('neutral');
  });

  it('neutral when there is no verdict.json (verdict didn\'t run, or the download failed), or one that can\'t be read', () => {
    expect(conclude(undefined)).toEqual({ conclusion: 'neutral', verdict: 'none' });
    expect(conclude('not json').conclusion).toBe('neutral');
    expect(conclude({ verdict: 'PASS' }).conclusion).toBe('neutral');
  });
});
