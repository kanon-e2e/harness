import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { exec as realExec } from '../runner/lib/proc.mjs';
import { runSegment } from '../runner/run.mjs';
import { validateScenarioDir } from '../runner/validate.mjs';
import { RELEASE, describeCall, fakeClock, tempDir } from './helpers/stubs.mjs';

/**
 * The `lane-check` family (Kanon plan 0012 §6.1 and step E12), held to E12's criteria as data,
 * and E12's mutation cell ("as E5, per scenario") as a run of each scenario's pull-request steps.
 *
 * Each scenario installs Kanon's review feature as `install-review` does, holds `Lane check` green
 * on the install's push, then opens two pull requests from the default branch: one that rewrites
 * the `apps-check` caller `init` wrote with one breakage an adopter plausibly makes, which `Lane
 * check` must fail, and one that rewrites it correctly, which `Lane check` must pass. The two
 * files differ only in the breakage, so the red is the breakage's and nothing else's.
 */

const ROOT = new URL('../', import.meta.url).pathname;
const CALLER = '.github/workflows/apps-check.yml';
const KANON_REF = /yedeya-labs\/kanon\/[^@\s]+@([^\s"']+)/g;
const EXACT = /^(?:candidate-)?v[0-9]+\.[0-9]+\.[0-9]+$/;

/** Each scenario, the breakage it makes, and the lane-check rule that catches it. */
const SCENARIOS = {
  'lane-check-inexact-pin': { rule: 'pin', ref: 'main', secrets: 'mapped' },
  'lane-check-mixed-pin': { rule: 'pin', ref: 'v0.40.2', secrets: 'mapped' },
  'lane-check-secrets-inherit': { rule: 'secrets', ref: '{{release}}', secrets: 'inherit' },
};

const load = (id) => {
  const dir = join(ROOT, 'scenarios', id);
  const read = (path) => readFileSync(join(dir, path), 'utf8');
  const { phases } = JSON.parse(read('steps.json'));
  const steps = phases.flatMap((p, i) => [...p.kanon.map((s) => ({ ...s, phase: i + 1, segment: 'kanon' })), ...p.act.map((s) => ({ ...s, phase: i + 1, segment: 'act' }))]);
  return { dir, read, phases, steps, scenario: JSON.parse(read('scenario.json')), ofVerb: (verb) => steps.filter((s) => s.verb === verb) };
};

/**
 * A stand-in for Kanon's lane-check, on the one file the scenarios change: the two rules they
 * break, as `actions/lane-check/lane-check.mjs` states them. `pin`: every Kanon reference pins an
 * exact version, one version, the one the check runs at. `secrets`: a job that calls a Kanon
 * workflow maps each secret by name, never `secrets: inherit`. `without` drops a rule, as a
 * regression in Kanon would. Each scenario's breakage and fix were also run once through the real
 * lane-check at candidate-v0.42.0, over the tree `init` writes: each breakage failed by exactly
 * its rule, and each fix passed.
 * @param {string} text @param {string} release @param {string[]} without
 */
const laneCheck = (text, release, without = []) => {
  const problems = [];
  const tags = [...new Set(text.split('\n').filter((l) => !/^\s*#/.test(l)).flatMap((l) => [...l.matchAll(KANON_REF)].map((m) => m[1])))];
  if (!without.includes('pin') && (tags.some((t) => !EXACT.test(t)) || tags.length > 1 || (tags.length && tags[0] !== release))) problems.push('pin');
  const jobs = parse(text)?.jobs ?? {};
  if (!without.includes('secrets') && Object.values(jobs).some((j) => typeof j?.secrets === 'string')) problems.push('secrets');
  return problems.length ? 'failure' : 'success';
};

describe.each(Object.entries(SCENARIOS))('%s', (id, { rule, ref, secrets }) => {
  const s = load(id);
  const at = (step) => s.steps.indexOf(step);
  const install = load('install-review');

  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it('scenario.json: family lane, no model, no Claude, the Judge alone, and gate: false until its burn-in (plan 0012 §10)', () => {
    expect(s.scenario).toEqual({ id, family: 'lane', tier: 'none', gate: false, apps: ['judge'], claude: 'none', deadlineMinutes: 45 });
  });

  it('installs as install-review does: the same kanon segment, one push of what init wrote, the settings, Lane check green on the push, then the Lane check rule', () => {
    expect(s.phases).toHaveLength(1);
    expect(s.phases[0].kanon).toEqual(install.phases[0].kanon);
    const act = s.phases[0].act;
    expect(act.slice(0, 5).map((x) => x.verb)).toEqual(['files.commit', 'repo.apply', 'run.await', 'expect.check', 'repo.apply']);
    expect(act[0]).toMatchObject({ from: 'kanon' });
    expect(act[0].branch).toBeUndefined();
    expect(act[2]).toMatchObject({ workflow: 'ci.yml', event: 'push', branch: 'main' });
    expect(act[3]).toMatchObject({ branch: 'main', name: 'Lane check', conclusion: 'success' });
    for (const a of s.ofVerb('repo.apply')) expect(a.firstCommit).toBe(true);
  });

  it('opens the broken pull request and the correct one from branches, never pushing to the default branch once the ruleset exists', () => {
    const [firstApply] = s.ofVerb('repo.apply');
    const commits = s.ofVerb('files.commit').filter((c) => c.from === 'scenario');
    expect(commits.map((c) => [c.dir, c.branch])).toEqual([['broken', 'broken'], ['fixed', 'fixed']]);
    for (const c of commits) expect(at(c)).toBeGreaterThan(at(firstApply));
    expect(s.ofVerb('pr.open').map((p) => [p.name, p.head, p.base])).toEqual([['broken', 'broken', undefined], ['fixed', 'fixed', undefined]]);
    expect(s.ofVerb('pr.merge')).toEqual([]);
  });

  it('expects Lane check to fail the broken pull request, by its run\'s job and by its check run, and to pass the correct one', () => {
    const act = s.phases[0].act;
    expect(act.slice(9).map((x) => [x.verb, x.pr ?? x.run])).toEqual([
      ['run.await', 'broken'], ['expect.run', 'ci-broken'], ['expect.check', 'broken'],
      ['run.await', 'fixed'], ['expect.run', 'ci-fixed'], ['expect.check', 'fixed'],
    ]);
    for (const [name, conclusion] of [['broken', 'failure'], ['fixed', 'success']]) {
      expect(s.ofVerb('run.await').find((x) => x.pr === name)).toMatchObject({ name: `ci-${name}`, workflow: 'ci.yml', event: 'pull_request' });
      expect(s.ofVerb('expect.run').find((x) => x.run === `ci-${name}`)).toMatchObject({ conclusion, jobs: [{ name: 'Lane check', conclusion }] });
      expect(s.ofVerb('expect.check').find((x) => x.pr === name)).toMatchObject({ name: 'Lane check', conclusion });
    }
  });

  it(`the broken caller differs from the correct one only in the breakage: ${rule === 'pin' ? `the pin \`@${ref}\`` : '`secrets: inherit`'}`, () => {
    const broken = s.read(`broken/${CALLER}`);
    const fixed = s.read(`fixed/${CALLER}`);
    const code = (t) => t.split('\n').filter((l) => !l.startsWith('#'));
    const changed = code(broken).filter((l) => !code(fixed).includes(l));
    if (rule === 'pin') expect(changed).toEqual([`    uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@${ref}`]);
    else expect(changed).toEqual(['    secrets: inherit']);
    expect(parse(broken).jobs.apps.secrets).toEqual(secrets === 'inherit' ? 'inherit' : { JUDGE_APP_ID: '${{ secrets.JUDGE_APP_ID }}', JUDGE_APP_PRIVATE_KEY: '${{ secrets.JUDGE_APP_PRIVATE_KEY }}' });
  });

  it('the correct caller is the one init writes for the Judge: pinned to {{release}}, each of its secrets mapped by name, run by hand only', () => {
    const fixed = parse(s.read(`fixed/${CALLER}`));
    expect(fixed.on).toEqual({ workflow_dispatch: null });
    expect(fixed.jobs.apps.uses).toBe('yedeya-labs/kanon/.github/workflows/apps-check.yml@{{release}}');
    expect(fixed.jobs.apps.secrets).toEqual({ JUDGE_APP_ID: '${{ secrets.JUDGE_APP_ID }}', JUDGE_APP_PRIVATE_KEY: '${{ secrets.JUDGE_APP_PRIVATE_KEY }}' });
    // Run by hand only, so neither pull request starts a run of it beside CI's.
    expect(parse(s.read(`broken/${CALLER}`)).on).toEqual({ workflow_dispatch: null });
  });

  it('the stand-in fails the broken caller by its rule alone, and passes the correct one', () => {
    const fill = (t) => t.replaceAll('{{release}}', RELEASE);
    expect(laneCheck(fill(s.read(`broken/${CALLER}`)), RELEASE)).toBe('failure');
    expect(laneCheck(fill(s.read(`broken/${CALLER}`)), RELEASE, [rule])).toBe('success');
    expect(laneCheck(fill(s.read(`fixed/${CALLER}`)), RELEASE)).toBe('success');
  });

  it('has a README in the house style', () => {
    const readme = s.read('README.md');
    for (const heading of ['The breakage', 'The steps', 'What it creates', 'What it costs', 'When it is red']) expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    expect(readme).toContain('`gate: false`');
    expect(readme).toContain(rule === 'pin' ? `@${ref}` : 'secrets: inherit');
  });
});

/**
 * E12's mutation cell, "as E5, per scenario": each scenario's pull-request steps run through the
 * runner's `act` segment on a real git (a bare repository standing in for the scenario
 * repository) and a stubbed GitHub, whose `Lane check` reads the committed caller with the
 * stand-in above. The scenario reads `pass`. Each of these reads `fail`:
 * - a copy that expects `Lane check` to pass the broken pull request;
 * - a Kanon whose lane-check lost the rule the scenario breaks;
 * - a copy whose correct pull request holds the breakage too.
 */
describe('E12\'s mutation: each scenario reads fail when its expectation, or Kanon\'s rule, is wrong', () => {
  const OWNER_REPO = 'kanon-e2e/e2e-lane-check-123-1';

  /** A copy of the scenario, in a fresh scenarios/ root, with its steps from the first broken commit on. */
  const copy = (id, { mutateSteps = (x) => x, fixedFrom } = {}) => {
    const dir = join(tempDir('scenarios-'), id);
    cpSync(join(ROOT, 'scenarios', id), dir, { recursive: true });
    if (fixedFrom) cpSync(join(ROOT, 'scenarios', id, fixedFrom), join(dir, 'fixed'), { recursive: true });
    const { phases } = JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8'));
    const act = phases[0].act;
    const from = act.findIndex((x) => x.verb === 'files.commit' && x.from === 'scenario');
    writeFileSync(join(dir, 'steps.json'), JSON.stringify({ phases: [{ kanon: [], act: mutateSteps(act.slice(from)) }] }));
    return dir;
  };

  /** A stubbed GitHub over the bare repository: pull requests, CI's runs and `Lane check`, by the stand-in. */
  const github = (remote, without) => {
    const git = (...args) => execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' }).trim();
    const prs = [];
    const shas = [];
    const verdict = (sha) => laneCheck(git('show', `${sha}:${CALLER}`), RELEASE, without);
    const routes = [
      [/^GET repos\/[^/]+\/[^/]+$/, () => ({ full_name: OWNER_REPO, default_branch: 'main', topics: ['kanon-e2e', 'kanon-e2e-provisioned'], archived: false })],
      [/^(DELETE repos\/[^/]+\/[^/]+|PATCH repos\/[^/]+\/[^/]+|PUT repos\/.+\/topics)$/, (c) => c.body ?? {}],
      [/^POST repos\/.+\/pulls$/, (c) => { prs.push(c.body.head); return { number: prs.length }; }],
      [/^GET repos\/.+\/pulls\/(\d+)$/, (c, m) => ({ number: Number(m[1]), head: { sha: git('rev-parse', `refs/heads/${prs[Number(m[1]) - 1]}`) } })],
      [/^GET repos\/.+\/actions\/workflows\/ci\.yml\/runs\?event=pull_request&head_sha=([0-9a-f]{40})&/, (c, m) => {
        if (!shas.includes(m[1])) shas.push(m[1]);
        return { workflow_runs: [{ id: shas.indexOf(m[1]) + 1, run_number: 1, status: 'completed', conclusion: verdict(m[1]) }] };
      }],
      [/^GET repos\/.+\/actions\/runs\/(\d+)\/jobs\?/, (c, m) => ({ jobs: [{ name: 'Lane check', conclusion: verdict(shas[Number(m[1]) - 1]) }] })],
      [/^GET repos\/.+\/actions\/runs\/(\d+)$/, (c, m) => ({ id: Number(m[1]), conclusion: verdict(shas[Number(m[1]) - 1]) })],
      [/^GET repos\/.+\/commits\/([0-9a-f]{40})\/check-runs\?check_name=Lane%20check&/, (c, m) => ({ total_count: 1, check_runs: [{ id: 1, name: 'Lane check', status: 'completed', conclusion: verdict(m[1]) }] })],
    ];
    return async (args, input) => {
      const call = describeCall(args, input);
      for (const [re, answer] of routes) {
        const m = re.exec(call.key);
        if (m) return { status: 0, stdout: JSON.stringify(answer(call, m)), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `stub: no route for ${call.key}` };
    };
  };

  const run = async (dir, { without = [] } = {}) => {
    const remote = join(tempDir('remote-'), 'repo.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const clock = fakeClock();
    const id = dir.split('/').at(-1);
    const state = {
      schema: 'kanon-e2e-state/v1', scenario: id, repository: OWNER_REPO, release: RELEASE, startedAt: clock.now(),
      laid: false, ref: null, steps: [], result: null, firstFailure: null, finalized: false,
    };
    const { result } = await runSegment({
      segment: 'act', phase: 1, scenarioDir: dir, repository: OWNER_REPO, release: RELEASE, trigger: 'nightly', harness: 'kanon-e2e/harness',
      run: { id: '123', attempt: '1', url: 'https://github.com/kanon-e2e/harness/actions/runs/123' }, state, work: tempDir('work-'), remote,
    }, { gh: github(remote, without), exec: realExec, now: clock.now, sleep: clock.sleep, log: () => {} });
    return result;
  };

  /** Each run spawns git a few dozen times: a loaded machine needs more than the default 5 seconds. */
  const SLOW = 30_000;

  /** The steps with the broken pull request's expectations turned to `success`. */
  const expectingGreen = (act) => act.map((x) => {
    if (x.verb === 'expect.check' && x.pr === 'broken') return { ...x, conclusion: 'success' };
    if (x.verb === 'expect.run' && x.run === 'ci-broken') return { ...x, conclusion: 'success', jobs: x.jobs.map((j) => ({ ...j, conclusion: 'success' })) };
    return x;
  });

  describe.each(Object.entries(SCENARIOS))('%s', (id, { rule }) => {
    it('reads pass as it stands: Lane check fails the broken pull request and passes the correct one', async () => {
      const result = await run(copy(id));
      expect(result).toMatchObject({ result: 'pass', firstFailure: null });
    }, SLOW);

    it('a copy that expects Lane check to pass the broken pull request reads fail, at the broken pull request\'s run', async () => {
      const result = await run(copy(id, { mutateSteps: expectingGreen }));
      expect(result.result).toBe('fail');
      expect(result.firstFailure).toMatchObject({ verb: 'expect.run', message: expect.stringMatching(/expected `success`, read `failure`/) });
    }, SLOW);

    it(`a Kanon whose lane-check lost its \`${rule}\` rule reads fail: the broken pull request goes green`, async () => {
      const result = await run(copy(id), { without: [rule] });
      expect(result.result).toBe('fail');
      expect(result.firstFailure).toMatchObject({ verb: 'expect.run', message: expect.stringMatching(/expected `failure`, read `success`/) });
    }, SLOW);

    it('a copy whose correct pull request holds the breakage too reads fail, at the correct pull request\'s run', async () => {
      const result = await run(copy(id, { fixedFrom: 'broken' }));
      expect(result.result).toBe('fail');
      expect(result.firstFailure).toMatchObject({ verb: 'expect.run', message: expect.stringMatching(/expected `success`, read `failure`/) });
    }, SLOW);
  });
});
