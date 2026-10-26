import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gate, labelsKept, phasesOf, repositoryName } from '../runner/gate.mjs';
import { tempDir } from './helpers/stubs.mjs';
import { readWorkflows } from './helpers/workflows.mjs';

/**
 * The gate before phases 2 and 3 (harness #62): the scenarios a phase runs are the planned ones
 * that have that phase and that no earlier phase ended. A two-phase scenario that passed has had
 * its repository deleted, so a phase-3 mint scoped to it fails, and a passing run went red.
 *
 * Whether a scenario ended, the gate reads from its repository (#24, R2): the `act` job that
 * learns a result records it as a topic before it deletes or archives the repository, and only
 * the act token can do any of the three. It never reads a `kanon-e2e-result-<scenario>`
 * artifact, which code in a `kanon` job can plant.
 */

const RUN = { id: '39213363892', attempt: '1' };
const entry = (id) => ({ id, apps: ['author'], claude: 'none', gate: true });
/** A repository as `GET repos/<owner>/<name>` answers for it, as `provision` left it and an `act` job marked it. */
const standing = (...topics) => ({ repo: { topics: ['kanon-e2e', 'kanon-e2e-provisioned', ...topics], archived: false } });
const TOPIC = { pass: 'kanon-e2e-passed', fail: 'kanon-e2e-failed', infra: 'kanon-e2e-infra' };
const phases = { two: 2, three: 3, one: 1 };
const decide = (phase, repositories = {}, planned = ['one', 'two', 'three'].map(entry)) => gate({ phase, planned, repositories, phasesOf: (id) => phases[id] });

describe('gate: the scenarios phase N runs', () => {
  it('drops a scenario with fewer than N phases, and keeps one with N or more', () => {
    expect(decide(2).scenarios.map((s) => s.id)).toEqual(['two', 'three']);
    expect(decide(3).scenarios.map((s) => s.id)).toEqual(['three']);
    expect(decide(3).dropped).toEqual([
      { id: 'one', why: 'it has 1 phase; there is no phase 3' },
      { id: 'two', why: 'it has 2 phases; there is no phase 3' },
    ]);
  });

  it('drops a scenario whose repository records a result, whatever it reads: pass, fail or infra', () => {
    for (const r of ['pass', 'fail', 'infra']) {
      const d = decide(2, { three: standing(TOPIC[r]) });
      expect(d.scenarios.map((s) => s.id), r).toEqual(['two']);
      expect(d.dropped, r).toEqual([{ id: 'one', why: 'it has 1 phase; there is no phase 2' }, { id: 'three', why: `it ended in an earlier phase: its repository records ${r}` }]);
    }
  });

  it('drops a scenario whose repository is gone or archived: only an `act` job deletes or archives one', () => {
    expect(decide(3, { three: { gone: true } }).dropped.at(-1)).toEqual({ id: 'three', why: 'it ended in an earlier phase: its repository is gone' });
    expect(decide(3, { three: { repo: { topics: ['kanon-e2e'], archived: true } } }).dropped.at(-1)).toEqual({ id: 'three', why: 'it ended in an earlier phase: its repository is archived' });
  });

  it('keeps a scenario whose repository records no result, so a failure there still fails its job', () => {
    expect(decide(3, { two: standing(TOPIC.pass), three: standing() }).scenarios).toEqual([entry('three')]);
  });

  it('keeps one whose repository it couldn\'t read, and says so: its own `act` job reads the repository again', () => {
    const d = decide(3, { three: { problem: 'HTTP 502' } });
    expect(d.scenarios).toEqual([entry('three')]);
    expect(d.unread).toEqual([{ id: 'three', why: 'HTTP 502' }]);
  });

  it('hands each kept scenario on as `plan` planned it, so the phase\'s matrix is the same entries', () => {
    const planned = [{ ...entry('three'), apps: ['author', 'judge'], claude: 'subscription' }];
    expect(decide(2, {}, planned).scenarios).toEqual(planned);
  });

  it('MUTATION: hands on the Author\'s labels only of the scenarios it kept, so `author-label` mints for no repository an earlier phase ended (#108)', () => {
    const labels = [{ id: 'two', head: 'docs-note', label: 'review:please' }, { id: 'three', head: 'fix', label: 'review:please' }];
    const d = decide(2, { three: { gone: true } });
    expect(labelsKept(labels, d.scenarios)).toEqual([labels[0]]);
    expect(labelsKept(labels, decide(2, { two: standing(TOPIC.infra), three: standing(TOPIC.fail) }).scenarios)).toEqual([]);
    expect(labelsKept(labels, decide(2).scenarios)).toEqual(labels);
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
  /** A `gh` on PATH answering `GET repos/kanon-e2e/<name>` from REPOS_FILE: a repository, or `gone` for a 404. */
  const fakeGh = (dir) => {
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const repos = JSON.parse(fs.readFileSync(process.env.REPOS_FILE, 'utf8'));
const path = args[args.length - 1];
const m = /^repos\\/kanon-e2e\\/([^/]+)$/.exec(path);
if (args[0] !== 'api' || args.includes('-X') || !m) { process.stderr.write('no route'); process.exit(1); }
const r = repos[m[1]];
if (r === undefined || r === 'gone') { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
process.stdout.write(JSON.stringify(r));
`);
    chmodSync(join(dir, 'gh'), 0o755);
  };
  const runGate = (phase, repos = {}, more = {}) => {
    const dir = tempDir();
    fakeGh(dir);
    const all = { 'install-review': standing(), 'install-build': standing(), 'deploy-rehearsal': standing(), ...repos };
    writeFileSync(join(dir, 'repos.json'), JSON.stringify(Object.fromEntries(Object.entries(all).map(([id, r]) => [repositoryName(id, RUN.id, RUN.attempt), r.gone ? 'gone' : r.repo]))));
    const out = join(dir, 'output');
    const r = spawnSync(process.execPath, ['runner/gate.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, REPOS_FILE: join(dir, 'repos.json'), GH_LOG: join(dir, 'log'), GH_TOKEN: 'x',
        PHASE: String(phase), GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        GITHUB_RUN_ID: RUN.id, GITHUB_RUN_ATTEMPT: RUN.attempt, SCENARIOS: JSON.stringify(['install-review', 'install-build', 'deploy-rehearsal'].map(entry)), ...more,
      },
    });
    let calls = [];
    try {
      calls = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {}
    return { status: r.status, stderr: r.stderr, output: r.status === 0 ? readFileSync(out, 'utf8') : '', calls };
  };

  it('phase 3 of a run whose install scenarios passed: only deploy-rehearsal, and the gate itself exits 0', () => {
    const { status, output, calls } = runGate(3, { 'install-review': { gone: true }, 'install-build': standing(TOPIC.pass) });
    expect(status).toBe(0);
    expect(output).toBe(`scenarios=${JSON.stringify([entry('deploy-rehearsal')])}\n`);
    // Only the scenario with a phase 3 is read, and only by GET.
    expect(calls).toEqual([['api', `repos/kanon-e2e/${repositoryName('deploy-rehearsal', RUN.id, RUN.attempt)}`]]);
  });

  it('phase 2 after one scenario failed in phase 1: the others; with every scenario ended, an empty list, still exit 0', () => {
    expect(runGate(2, { 'install-build': { repo: { topics: ['kanon-e2e', TOPIC.fail], archived: true } } }).output)
      .toBe(`scenarios=${JSON.stringify(['install-review', 'deploy-rehearsal'].map(entry))}\n`);
    const all = runGate(2, { 'install-review': { gone: true }, 'install-build': standing(TOPIC.fail), 'deploy-rehearsal': standing(TOPIC.infra) });
    expect(all).toMatchObject({ status: 0, output: 'scenarios=[]\n' });
  });

  it('a `kanon-e2e-result-*` artifact planted by a `kanon` job\'s code ends nothing: the gate doesn\'t read one (#24)', () => {
    const e2e = readWorkflows()['e2e.yml'];
    for (const name of ['gate-2', 'gate-3']) {
      expect(e2e.jobs[name].steps.filter((s) => String(s.uses).startsWith('actions/download-artifact@')), name).toEqual([]);
      expect(e2e.jobs[name].steps.find((s) => s.id === 'gate').env, name).toMatchObject({ GH_TOKEN: '${{ github.token }}' });
    }
    expect(readFileSync('runner/gate.mjs', 'utf8')).not.toMatch(/readResults|RESULTS_DIR/);
  });

  it('with AUTHOR_LABELS, as gate-2 runs it, also writes the labels of the scenarios it kept (#108)', () => {
    const labels = [{ id: 'install-review', head: 'docs-note', label: 'review:please' }, { id: 'install-build', head: 'fix', label: 'review:please' }];
    const { status, output } = runGate(2, { 'install-build': { gone: true } }, { AUTHOR_LABELS: JSON.stringify(labels) });
    expect(status).toBe(0);
    expect(output).toBe(`scenarios=${JSON.stringify(['install-review', 'deploy-rehearsal'].map(entry))}\nauthor-labels=${JSON.stringify([labels[0]])}\n`);
  });

  it('MUTATION: with AUTHOR_DISPATCHES, as gate-2 runs it, also writes the dispatches of the scenarios it kept, after the labels (#123)', () => {
    const labels = [{ id: 'install-review', head: 'docs-note', label: 'review:please' }];
    const dispatches = [{ id: 'install-review', workflow: 'agent-project-digest.yml' }, { id: 'install-build', workflow: 'agent-project-digest.yml' }];
    const both = runGate(2, { 'install-build': { gone: true } }, { AUTHOR_LABELS: JSON.stringify(labels), AUTHOR_DISPATCHES: JSON.stringify(dispatches) });
    expect(both.status).toBe(0);
    expect(both.output).toBe(`scenarios=${JSON.stringify(['install-review', 'deploy-rehearsal'].map(entry))}\nauthor-labels=${JSON.stringify(labels)}\nauthor-dispatches=${JSON.stringify([dispatches[0]])}\n`);
    const ended = runGate(2, { 'install-review': { gone: true }, 'install-build': standing(TOPIC.fail) }, { AUTHOR_DISPATCHES: JSON.stringify(dispatches) });
    expect(ended.output).toBe(`scenarios=${JSON.stringify([entry('deploy-rehearsal')])}\nauthor-dispatches=[]\n`);
  });

  it('refuses a phase that has no gate: 1, or past three', () => {
    for (const p of [1, 4, 'x']) expect(runGate(p).status, String(p)).not.toBe(0);
  });
});
