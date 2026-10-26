import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateScenarioDir, validateScenarioJson } from '../runner/validate.mjs';
import { SETTINGS } from '../runner/sizing.mjs';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { REPO, RELEASE, context, stubGh, tempDir, writeTree } from './helpers/stubs.mjs';

/**
 * `notify-revoked` (harness #123; Kanon plan 0011 step N12), held to its issue and the Owner's
 * decisions of 2026-10-25 as data: install-review's install with the project digest and Kanon's
 * Slack hook, a dead webhook `provision` writes (`chatPlaceholder`), the digest dispatched by the
 * test Author (`authorDispatch`), `runsOn` candidate and dispatch, the `notify` job red and the
 * `digest` job green, and doctor's `notify.failing` as a note. Its last block runs the scenario's
 * own expectations on a dead-hook run and on runs that must fail them.
 */

const ROOT = new URL('../', import.meta.url).pathname;
const load = (id) => {
  const dir = join(ROOT, 'scenarios', id);
  const read = (path) => readFileSync(join(dir, path), 'utf8');
  return { dir, read, scenario: JSON.parse(read('scenario.json')), phases: JSON.parse(read('steps.json')).phases };
};
const s = load('notify-revoked');
const install = load('install-review');
const bare = ({ ...step }) => step;
const fails = { name: 'Fail' };

describe('notify-revoked', () => {
  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it('scenario.json: the model tier on the subscription token, gate: false, candidates and dispatches only, the dead webhook and the Author\'s dispatch of the digest', () => {
    expect(s.scenario).toEqual({
      id: 'notify-revoked', family: 'lane', tier: 'model', gate: false, apps: ['author', 'judge'], claude: 'subscription', deadlineMinutes: 120,
      runsOn: ['candidate', 'dispatch'], chatPlaceholder: true, authorDispatch: { workflow: 'agent-project-digest.yml' },
    });
  });

  it('phase 1 is install-review\'s install, with the project digest, Kanon\'s Slack hook and the subscription token', () => {
    const [p1] = s.phases;
    expect(p1.kanon[0].flags).toEqual(['--lanes=review,project-digest', '--review-trigger=labelled', '--chat=slack', '--claude-auth=subscription', '--no-sensitive-data']);
    expect(p1.kanon[1]).toEqual(install.phases[0].kanon[1]);
    const [, , init] = p1.kanon;
    const [, , installInit] = install.phases[0].kanon;
    expect(init).toEqual({ ...installInit, fields: [...installInit.fields, { pointer: '/answers/chat', equals: 'slack' }] });
    expect(p1.act.slice(1)).toEqual(install.phases[0].act.slice(1));
    expect(p1.act[0]).toMatchObject({ verb: 'files.commit', from: 'kanon' });
  });

  it('no step dispatches the digest as the driver: the Author does, between phase 1 and phase 2', () => {
    const steps = s.phases.flatMap((p) => [...p.kanon, ...p.act]);
    expect(steps.filter((x) => x.verb === 'workflow.dispatch').map((x) => x.workflow)).toEqual(['apps-check.yml']);
    expect(s.phases[1].act[0]).toEqual({ verb: 'run.await', name: 'digest', workflow: s.scenario.authorDispatch.workflow, event: 'workflow_dispatch', branch: 'main', actor: 'author', deadline: 23 });
  });

  it('phase 2 holds the digest\'s cost row first, then the run: `notify` red, `digest` green; phase 3 holds doctor to `notify.failing`, blocking nothing', () => {
    expect(s.phases[1].kanon).toEqual([]);
    expect(s.phases[1].act.map((x) => x.verb)).toEqual(['run.await', 'expect.row', 'expect.run']);
    expect(s.phases[1].act[1]).toEqual({ verb: 'expect.row', run: 'digest', lane: 'project-digest', job: 'digest / digest', ceilingUsd: 10, deadline: 5 });
    expect(s.phases[1].act[2]).toMatchObject({ conclusion: 'failure', jobs: [{ name: 'digest / gate', conclusion: 'success' }, { name: 'digest / digest', conclusion: 'success' }, { name: 'digest / notify', conclusion: 'failure' }] });
    expect(s.phases[2]).toEqual({ kanon: [{ verb: 'kanon.doctor' }, { verb: 'expect.doctor', unchecked: ['secrets', 'notify-secrets'], findings: ['notify.failing'], blocking: [] }], act: [] });
  });

  // MUTATION: a phase whose `act` waits pass the `act` job's timeout is killed before its result
  // step runs, so a slow digest would read `missing`, not `fail`, and record no cost (#145).
  it('MUTATION: fits each phase\'s `act` waits in an `act` job\'s 30 minutes', () => {
    expect(SETTINGS.minutes.act).toBe(30);
    for (const [i, p] of s.phases.entries()) expect(p.act.reduce((n, x) => n + (x.deadline ?? 0), 0), `phase ${i + 1}`).toBeLessThanOrEqual(SETTINGS.minutes.act);
  });

  it('asserts no collector `notify` row: only the digest\'s own cost row, `expect.row`\'s one kind', () => {
    const rows = s.phases.flatMap((p) => p.act).filter((x) => x.verb === 'expect.row');
    expect(rows.map((r) => r.lane)).toEqual(['project-digest']);
  });

  it('has a README in the house style, saying why there is no telemetry row assertion and that the first run is the Owner\'s dispatch, alone', () => {
    const readme = s.read('README.md');
    for (const heading of ['The dead webhook', 'Who dispatches the digest', 'What the repository holds', 'The flags', 'The steps', 'What it creates', 'What it costs', 'When it is red']) expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    expect(readme).toContain('`gate: false`');
    expect(readme).toContain('https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX');
    expect(readme).toMatch(/A throwaway scenario repository isn't registered with the collector/);
    expect(readme).toMatch(/The first run is the Owner's dispatch, with this scenario selected alone/);
    expect(readme).toContain('select=notify-revoked');
    // The Author's mint asks for Actions write, which its App registration must grant first (#145).
    expect(readme).toMatch(/Before that first dispatch, the Author App's registration must grant Actions write/);
  });
});

describe('`authorDispatch` and `chatPlaceholder` in scenario.json', () => {
  const base = { id: 'x', family: 'lane', tier: 'model', gate: false, apps: ['author'], claude: 'subscription', deadlineMinutes: 60 };

  it('`authorDispatch` takes exactly a workflow file name, for a real-model scenario that lists the Author', () => {
    expect(validateScenarioJson({ ...base, authorDispatch: { workflow: 'agent-project-digest.yml' } }, 'x')).toEqual([]);
    for (const [over, re] of [
      [{ authorDispatch: { workflow: 'a.yml', ref: 'main' } }, /holds exactly `workflow`/],
      [{ authorDispatch: {} }, /holds exactly `workflow`/],
      [{ authorDispatch: { workflow: '../a.yml' } }, /not a workflow's file name/],
      [{ authorDispatch: { workflow: 'a.sh' } }, /not a workflow's file name/],
      [{ apps: ['judge'], authorDispatch: { workflow: 'a.yml' } }, /doesn't list `author`/],
      [{ claude: 'none', tier: 'none', authorDispatch: { workflow: 'a.yml' } }, /real-model scenario/],
    ]) expect(validateScenarioJson({ ...base, ...over }, 'x').join('\n')).toMatch(re);
  });

  it('`chatPlaceholder` is a boolean', () => {
    expect(validateScenarioJson({ ...base, chatPlaceholder: true }, 'x')).toEqual([]);
    expect(validateScenarioJson({ ...base, chatPlaceholder: 'yes' }, 'x').join('\n')).toMatch(/chatPlaceholder/);
  });

  it('`authorDispatch` needs a phase 2 to see the run, and the Author in the App register', () => {
    const dir = join(tempDir('dispatch-'), 'x');
    const write = (steps) => writeTree(dir, { 'scenario.json': JSON.stringify({ ...base, authorDispatch: { workflow: 'a.yml' } }), 'start/README.md': 'x', 'steps.json': JSON.stringify(steps) });
    const p1 = { kanon: [{ verb: 'register.write' }], act: [] };
    const p2 = { kanon: [], act: [{ verb: 'run.await', workflow: 'a.yml', event: 'workflow_dispatch', branch: 'main', actor: 'author', deadline: 5 }] };
    write({ phases: [p1, p2] });
    expect(validateScenarioDir(dir)).toEqual([]);
    write({ phases: [p1] });
    expect(validateScenarioDir(dir).join('\n')).toMatch(/`authorDispatch` runs between phase 1 and phase 2/);
    write({ phases: [{ kanon: [{ verb: 'kanon.init' }], act: [] }, p2] });
    expect(validateScenarioDir(dir).join('\n')).toMatch(/no step runs `register.write`/);
  });
});

describe('notify-revoked\'s expectations on a dead-hook run, and on runs that must fail them', () => {
  const RUN = 9;
  const [awaited, row, run] = s.phases[1].act;
  const [, doctorStep] = s.phases[2].kanon;
  const runOf = (conclusion, jobs) => stubGh({
    [`GET repos/${REPO}/actions/runs/${RUN}`]: { id: RUN, status: 'completed', conclusion },
    [`GET repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100`]: { jobs: jobs.map(([name, c], i) => ({ id: 100 + i, name, conclusion: c })) },
  }).gh;
  const holdRun = (gh) => VOCABULARY['expect.run'].run(bare(run), context({ gh, state: { runs: { digest: RUN } } }));
  const DEAD = [['digest / gate', 'success'], ['digest / digest', 'success'], ['digest / health', 'success'], ['digest / notify', 'failure']];

  it('phase 2 keeps the run the Author\'s dispatch started, not a run the driver started on the same commit', async () => {
    const by = (login, id) => ({ id, run_number: id, status: 'completed', conclusion: 'failure', triggering_actor: { login } });
    const g = stubGh({
      [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } },
      [`GET repos/${REPO}/actions/workflows/agent-project-digest.yml/runs?event=workflow_dispatch&head_sha=abc&per_page=20`]: { workflow_runs: [by('kanon-e2e-author[bot]', 2), by('kanon-e2e-driver[bot]', 3)] },
    });
    const ctx = context({ gh: g.gh });
    await VOCABULARY['run.await'].run(bare(awaited), ctx);
    expect(ctx.state.runs.digest).toBe(2);
  });

  it('the run: passes when `notify` failed and `digest` succeeded', async () => {
    await holdRun(runOf('failure', DEAD));
  });

  it('the run: fails when the post didn\'t fail, when the producer failed, or when the gate refused the dispatch', async () => {
    await expect(holdRun(runOf('success', DEAD.map(([n, c]) => [n, n === 'digest / notify' ? 'success' : c])))).rejects.toMatchObject(fails);
    await expect(holdRun(runOf('failure', DEAD.map(([n, c]) => [n, n === 'digest / digest' ? 'failure' : c])))).rejects.toMatchObject(fails);
    await expect(holdRun(runOf('success', DEAD.map(([n]) => [n, n === 'digest / gate' ? 'success' : 'skipped'])))).rejects.toMatchObject(fails);
  });

  it('the row: a run whose gate skipped the digest fails at once, naming `digest / gate` beside it', async () => {
    const { gh } = stubGh({
      [`GET repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`]: { artifacts: [] },
      [`GET repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100`]: { jobs: [{ id: 1, name: 'digest / gate', conclusion: 'success' }, { id: 2, name: 'digest / digest', conclusion: 'skipped' }, { id: 3, name: 'digest / notify', conclusion: 'skipped' }] },
    });
    const ctx = context({ gh, state: { runs: { digest: RUN } } });
    const start = ctx.now();
    await expect(VOCABULARY['expect.row'].run(bare(row), ctx)).rejects.toMatchObject({ ...fails, message: expect.stringMatching(/job `digest \/ digest` was skipped.*`digest \/ gate` `success`/) });
    expect(ctx.now()).toBe(start);
  });

  describe('doctor', () => {
    const f = (id, blocking) => ({ id, category: id.split('.')[0], blocking, subject: 'agent-project-digest.yml', message: 'prose', fix: { text: 'prose' } });
    const unchecked = (checks) => checks.map((check) => ({ check, subject: 'kanon-e2e/e2e-notify-revoked-1-1', reason: 'the token can\'t list them' }));
    const doc = (findings, checks = ['secrets', 'notify-secrets']) => ({
      schema: 'kanon-doctor/v1', kanon: 'v0.41.0', status: 'incomplete', exitCode: 4, releases: { pins: [RELEASE], pinned: RELEASE }, findings, waived: [], unchecked: unchecked(checks),
    });
    const hold = (document) => VOCABULARY['expect.doctor'].run(bare(doctorStep), context({ state: { documents: { doctor: { release: RELEASE, exit: document.exitCode, document } } } }));

    it('passes when doctor reports `notify.failing`, blocking nothing, with `secrets` and `notify-secrets` unchecked or only `secrets`', async () => {
      await hold(doc([f('notify.failing', false), f('pin.candidate', false)]));
      await hold(doc([f('notify.failing', false)], ['secrets']));
    });

    it('fails without `notify.failing`, when it blocks, when another finding blocks, or when `notify-runs` couldn\'t be read', async () => {
      await expect(hold(doc([f('pin.candidate', false)]))).rejects.toMatchObject(fails);
      await expect(hold({ ...doc([f('notify.failing', true)]), status: 'findings', exitCode: 1 })).rejects.toMatchObject(fails);
      await expect(hold({ ...doc([f('notify.failing', false), f('ruleset.missing', true)]), status: 'findings', exitCode: 1 })).rejects.toMatchObject(fails);
      await expect(hold(doc([f('notify.failing', false)], ['secrets', 'notify-runs']))).rejects.toMatchObject(fails);
    });
  });
});
