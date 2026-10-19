import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gate, phasesOf, repositoryName } from '../runner/gate.mjs';
import { tempDir, writeTree } from './helpers/stubs.mjs';
import { readWorkflows } from './helpers/workflows.mjs';

/**
 * The gate before phases 2 and 3 (harness #62): the scenarios a phase runs are the planned ones
 * that have that phase and that no earlier phase ended. A two-phase scenario that passed has had
 * its repository deleted, so a phase-3 mint scoped to it fails, and a passing run went red.
 */

const RUN = { id: '39213363892', attempt: '1' };
const entry = (id) => ({ id, apps: ['author'], claude: 'none', gate: true });
const repo = (id, run = RUN) => `kanon-e2e/${repositoryName(id, run.id, run.attempt)}`;
const ended = (id, result, more = {}) => ({ schema: 'kanon-e2e-result/v1', scenario: id, result, repository: repo(id), ...more });
const phases = { two: 2, three: 3, one: 1 };
const decide = (phase, results, planned = ['one', 'two', 'three'].map(entry)) => gate({ phase, planned, results, run: RUN, phasesOf: (id) => phases[id] });

describe('gate: the scenarios phase N runs', () => {
  it('drops a scenario with fewer than N phases, and keeps one with N or more', () => {
    expect(decide(2, []).scenarios.map((s) => s.id)).toEqual(['two', 'three']);
    expect(decide(3, []).scenarios.map((s) => s.id)).toEqual(['three']);
    expect(decide(3, []).dropped).toEqual([
      { id: 'one', why: 'it has 1 phase; there is no phase 3' },
      { id: 'two', why: 'it has 2 phases; there is no phase 3' },
    ]);
  });

  it('drops a scenario an earlier phase ended, whatever it read: pass, fail or infra', () => {
    for (const r of ['pass', 'fail', 'infra']) {
      const d = decide(2, [ended('three', r)]);
      expect(d.scenarios.map((s) => s.id), r).toEqual(['two']);
      expect(d.dropped, r).toEqual([{ id: 'one', why: 'it has 1 phase; there is no phase 2' }, { id: 'three', why: `it ended in an earlier phase: it reads ${r}` }]);
    }
  });

  it('keeps a scenario that reached phase N with no result, so a failure there still fails its job', () => {
    expect(decide(3, [ended('two', 'pass')]).scenarios).toEqual([entry('three')]);
  });

  it('a result counts only for its own scenario and this attempt\'s repository: an earlier attempt\'s, another scenario\'s or a malformed one changes nothing', () => {
    const earlier = { ...RUN, attempt: '0' };
    expect(decide(3, [ended('three', 'fail', { repository: repo('three', earlier) })]).scenarios.map((s) => s.id)).toEqual(['three']);
    expect(decide(3, [ended('two', 'fail', { repository: repo('three') })]).scenarios.map((s) => s.id)).toEqual(['three']);
    expect(decide(3, [ended('three', 'fail', { schema: 'something-else/v1' })]).scenarios.map((s) => s.id)).toEqual(['three']);
    expect(decide(3, [null, 'pass', [], { scenario: 'three' }]).scenarios.map((s) => s.id)).toEqual(['three']);
  });

  it('hands each kept scenario on as `plan` planned it, so the phase\'s matrix is the same entries', () => {
    const planned = [{ ...entry('three'), apps: ['author', 'judge'], claude: 'subscription' }];
    expect(decide(2, [], planned).scenarios).toEqual(planned);
  });

  it('reads the phases from the catalogue: the install scenarios have two, deploy-rehearsal three', () => {
    expect(phasesOf('install-review')).toBe(2);
    expect(phasesOf('deploy-rehearsal')).toBe(3);
  });
});

describe('gate: the repository name is the one e2e.yml\'s scenario jobs use', () => {
  it('matches every scenario job\'s `repository-name`', () => {
    const e2e = readWorkflows()['e2e.yml'];
    for (const name of ['kanon-1', 'act-1', 'kanon-2', 'act-2', 'kanon-3', 'act-3']) {
      const template = e2e.jobs[name].with['repository-name'];
      const filled = template.replace('${{ matrix.scenario.id }}', 'install-review').replace('${{ github.run_id }}', RUN.id).replace('${{ github.run_attempt }}', RUN.attempt);
      expect(filled, name).toBe(repositoryName('install-review', RUN.id, RUN.attempt));
    }
  });
});

describe('gate: node runner/gate.mjs, as gate-2 and gate-3 run it', () => {
  const runGate = (phase, files) => {
    const dir = tempDir();
    writeTree(join(dir, 'results'), files);
    const out = join(dir, 'output');
    const r = spawnSync(process.execPath, ['runner/gate.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env, PHASE: String(phase), RESULTS_DIR: join(dir, 'results'), GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GITHUB_RUN_ID: RUN.id, GITHUB_RUN_ATTEMPT: RUN.attempt, SCENARIOS: JSON.stringify(['install-review', 'install-build', 'deploy-rehearsal'].map(entry)),
      },
    });
    return { status: r.status, stderr: r.stderr, output: r.status === 0 ? readFileSync(out, 'utf8') : '' };
  };
  const result = (id, r) => JSON.stringify({ schema: 'kanon-e2e-result/v1', scenario: id, result: r, repository: repo(id) });

  it('phase 3 of a run whose install scenarios passed: only deploy-rehearsal, and the gate itself exits 0', () => {
    const { status, output } = runGate(3, { 'kanon-e2e-result-install-review/result.json': result('install-review', 'pass'), 'kanon-e2e-result-install-build/result.json': result('install-build', 'pass') });
    expect(status).toBe(0);
    expect(output).toBe(`scenarios=${JSON.stringify([entry('deploy-rehearsal')])}\n`);
  });

  it('phase 2 after one scenario failed in phase 1: the others; with every scenario ended, an empty list, still exit 0', () => {
    expect(runGate(2, { 'kanon-e2e-result-install-build/result.json': result('install-build', 'fail') }).output)
      .toBe(`scenarios=${JSON.stringify(['install-review', 'deploy-rehearsal'].map(entry))}\n`);
    const all = runGate(2, {
      'kanon-e2e-result-install-review/result.json': result('install-review', 'infra'),
      'kanon-e2e-result-install-build/result.json': result('install-build', 'fail'),
      'kanon-e2e-result-deploy-rehearsal/result.json': result('deploy-rehearsal', 'fail'),
    });
    expect(all).toMatchObject({ status: 0, output: 'scenarios=[]\n' });
  });

  it('one downloaded result lands in RESULTS_DIR itself (harness #30), and still counts', () => {
    expect(runGate(2, { 'result.json': result('install-build', 'fail') }).output)
      .toBe(`scenarios=${JSON.stringify(['install-review', 'deploy-rehearsal'].map(entry))}\n`);
  });

  it('refuses a phase that has no gate: 1, or past three', () => {
    for (const p of [1, 4, 'x']) expect(runGate(p, {}).status, String(p)).not.toBe(0);
  });
});
