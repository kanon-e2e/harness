import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateScenarioDir } from '../runner/validate.mjs';

/**
 * The upgrade scenarios (Kanon plan 0012 step E7, harness #42), held to the issue's acceptance
 * criteria as data. Each installs Kanon's full feature at an older stable release with that
 * release's own `init` (`kanon.at`), lists what the release under test needs (`kanon.doctor --to`),
 * moves the pins (`pins.move`), runs `init` at the release under test, merges the upgrade through
 * a pull request, applies what the new `init` document names, and holds doctor to healthy at the
 * release under test. The upgrade skill never runs: the verbs do its edits (§4.2).
 */

const ROOT = new URL('../', import.meta.url).pathname;
const SCENARIOS = { 'upgrade-previous': 'previous', 'upgrade-previous-1': 'previous-1' };
/** The same flags at both releases: the older `init` refuses `--chat`, which it doesn't know. */
const FLAGS = ['--feature=full', '--review-trigger=labelled', '--no-sensitive-data'];

const load = (id) => {
  const dir = join(ROOT, 'scenarios', id);
  const read = (path) => readFileSync(join(dir, path), 'utf8');
  const { phases } = JSON.parse(read('steps.json'));
  const steps = phases.flatMap((p, i) => [...p.kanon.map((s) => ({ ...s, phase: i + 1, segment: 'kanon' })), ...p.act.map((s) => ({ ...s, phase: i + 1, segment: 'act' }))]);
  return { dir, read, phases, steps, scenario: JSON.parse(read('scenario.json')), ofVerb: (verb) => steps.filter((s) => s.verb === verb) };
};
const strip = ({ phase: _p, segment: _s, ...step }) => step;

/** The scenarios that burnt in and gate (#43): each turned `gate: true` in its own pull request. */
const GATED = new Set(['upgrade-previous', 'upgrade-previous-1']);

describe.each(Object.entries(SCENARIOS))('%s', (id, release) => {
  const s = load(id);
  const at = (step) => s.steps.indexOf(step);

  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it('scenario.json: family upgrade, no model, no Claude, the Author and the Judge, gate only once burnt in', () => {
    expect(s.scenario).toEqual({ id, family: 'upgrade', tier: 'none', gate: GATED.has(id), apps: ['author', 'judge'], claude: 'none', deadlineMinutes: expect.any(Number) });
  });

  it(`phase 1, kanon: the full feature with ${release}'s own init, through kanon.at, and the register at the same release`, () => {
    expect(s.phases[0].kanon.map(strip)).toEqual([
      { verb: 'kanon.at', release, command: 'init', flags: FLAGS },
      { verb: 'register.write', release },
    ]);
  });

  it('phase 1, act: the install steps, one push to the default branch before the ruleset, then the settings, apps-check, Lane check on the push and the Lane check rule', () => {
    expect(s.phases[0].act.map((x) => x.verb)).toEqual([
      'files.commit', 'bootstrap.end', 'repo.apply', 'workflow.dispatch', 'run.await', 'expect.run', 'run.await', 'expect.check', 'repo.apply',
    ]);
    expect(s.phases[0].act[0]).toMatchObject({ from: 'kanon' });
    expect(s.phases[0].act[0].branch).toBeUndefined();
    // The adoption record's `ended` line goes to the default branch before the ruleset exists (#59).
    expect(s.phases[0].act[1]).toEqual({ verb: 'bootstrap.end', move: 'record' });
    expect(s.phases[0].act[6]).toMatchObject({ workflow: 'ci.yml', event: 'push', branch: 'main' });
    expect(s.phases[0].act[7]).toMatchObject({ branch: 'main', name: 'Lane check', conclusion: 'success' });
    // The older release's init ran on a default branch with no commit, so it named
    // `ruleset.first-commit`: both calls take it for the ruleset and its Lane check rule (#55).
    expect([s.phases[0].act[2], s.phases[0].act[8]]).toEqual([
      { verb: 'repo.apply', firstCommit: true }, { verb: 'repo.apply', firstCommit: true },
    ]);
  });

  it('phase 2, act: repo.apply after the upgrade takes the new init document as it is, with no firstCommit', () => {
    for (const a of s.phases[1].act.filter((x) => x.verb === 'repo.apply')) expect(a.firstCommit).toBeUndefined();
  });

  it('phase 2, kanon: doctor --to, kept and held to /releases/to equal to {{release}}, then pins.move, then init at the release under test with the same flags', () => {
    expect(s.phases[1].kanon.map((x) => x.verb)).toEqual(['kanon.doctor', 'expect.doctor', 'pins.move', 'kanon.init']);
    const [to, held] = s.phases[1].kanon;
    expect(to).toEqual({ verb: 'kanon.doctor', to: true });
    expect(held.fields).toContainEqual({ pointer: '/releases/to', equals: '{{release}}' });
    expect(held.unchecked).toEqual(['secrets']);
    expect(s.phases[1].kanon[3]).toEqual({ verb: 'kanon.init', flags: FLAGS });
  });

  it('phase 2, act: the upgrade on a branch, through a pull request whose Lane check passed, merged by the front door, then what the new init document names', () => {
    expect(s.phases[1].act.map((x) => x.verb)).toEqual(['files.commit', 'pr.open', 'run.await', 'expect.check', 'pr.merge', 'expect.pr', 'repo.apply', 'repo.apply', 'bootstrap.end']);
    const [commit, open, ci, check, merge, merged] = s.phases[1].act;
    expect(commit).toMatchObject({ from: 'kanon', branch: open.head });
    expect(open.head).not.toBe('main');
    expect(open.base).toBeUndefined();
    expect(ci).toMatchObject({ workflow: 'ci.yml', event: 'pull_request', pr: open.name });
    expect(check).toMatchObject({ pr: open.name, name: 'Lane check', conclusion: 'success' });
    expect(merge).toMatchObject({ pr: open.name, via: 'front-door' });
    expect(merged).toMatchObject({ pr: open.name, state: 'merged' });
  });

  it('ends bootstrap only after the upgrade merges: the approval comes last in phase 2, since no model can approve the upgrade pull request (#59)', () => {
    const [approval] = s.ofVerb('bootstrap.end').filter((x) => x.move === 'approval');
    expect(s.phases[1].act.at(-1)).toEqual({ verb: 'bootstrap.end', move: 'approval' });
    expect(at(approval)).toBeGreaterThan(at(s.ofVerb('pr.merge').at(-1)));
    expect(s.ofVerb('bootstrap.end').map((x) => x.move)).toEqual(['record', 'approval']);
  });

  it('pushes to the default branch only before the ruleset exists; after it, only through the pull request', () => {
    const [firstApply] = s.ofVerb('repo.apply');
    for (const c of s.ofVerb('files.commit')) {
      if (c.branch === undefined) expect(at(c)).toBeLessThan(at(firstApply));
      else expect(c.branch).not.toBe('main');
    }
  });

  it('phase 3, kanon: doctor on the kanon job\'s token reads incomplete, exit 4, only `secrets` unchecked, every pin the release under test and no pin.mixed', () => {
    expect(s.phases).toHaveLength(3);
    expect(s.phases[2].kanon.map((x) => x.verb)).toEqual(['kanon.doctor', 'expect.doctor']);
    expect(s.phases[2].kanon[0]).toEqual({ verb: 'kanon.doctor' });
    expect(s.phases[2].act).toEqual([]);
    const e = s.phases[2].kanon[1];
    expect(e).toMatchObject({ status: 'incomplete', exitCode: 4, unchecked: ['secrets'] });
    expect(e.absent).toEqual(['pin.mixed', 'ruleset.bootstrap-can-end', 'ruleset.approval-off']);
    expect(e.findings).toBeUndefined();
    expect(e.fields).toEqual(expect.arrayContaining([
      { pointer: '/releases/pins', equals: ['{{release}}'] },
      { pointer: '/releases/pinned', equals: '{{release}}' },
    ]));
  });

  it('has a README in the style of probes/README.md, and an entry in the catalogue', () => {
    const readme = s.read('README.md');
    for (const heading of ['The flags', 'The steps', 'Why the upgrade merges through a pull request', 'What it creates', 'What it costs', 'When it is red']) {
      expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    }
    expect(readme).toContain(`\`${release}\``);
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain(`[\`${id}/\`](scenarios/${id}/README.md)`);
  });
});

describe('the docs', () => {
  it('the catalogue gives the dispatch command for the upgrade family', () => {
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain('gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=upgrade');
  });

  it('scenarios/README.md states repo.apply\'s new rule, and register.write\'s release', () => {
    const text = readFileSync(join(ROOT, 'scenarios/README.md'), 'utf8');
    expect(text).toMatch(/count starts again/);
    expect(text).toMatch(/`register\.write`[^\n]*`release`/);
  });
});
