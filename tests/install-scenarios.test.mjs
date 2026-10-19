import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateScenarioDir } from '../runner/validate.mjs';

/**
 * The install scenarios (Kanon plan 0012 step E6, harness #41), held to the issue's acceptance
 * criteria as data. Each installs Kanon into a fresh repository the way an adopter does: `kanon
 * init` for one feature at the release under test, the App register, a push of what init wrote,
 * the settings init leaves to a person (`repo.apply`), `apps-check`, the `Lane check` rule once a
 * run reports it, and doctor, which must find it healthy and pinned to the release under test.
 */

const ROOT = new URL('../', import.meta.url).pathname;
const SCENARIOS = {
  'install-review': { feature: 'review', apps: ['judge'] },
  'install-build': { feature: 'build', apps: ['author', 'judge'] },
  'install-full': { feature: 'full', apps: ['author', 'judge'] },
  'install-python': { feature: 'build', apps: ['author', 'judge'] },
};
/** The job apps-check's caller names for each App (Kanon's `apps-check.yml`: `apps`, then the App's name). */
const APP_JOBS = { author: 'apps / Author', judge: 'apps / Judge' };

const load = (id) => {
  const dir = join(ROOT, 'scenarios', id);
  const read = (path) => readFileSync(join(dir, path), 'utf8');
  const { phases } = JSON.parse(read('steps.json'));
  const steps = phases.flatMap((p, i) => [...p.kanon.map((s) => ({ ...s, phase: i + 1, segment: 'kanon' })), ...p.act.map((s) => ({ ...s, phase: i + 1, segment: 'act' }))]);
  return { dir, read, phases, steps, scenario: JSON.parse(read('scenario.json')), ofVerb: (verb) => steps.filter((s) => s.verb === verb) };
};

/** Every file under a directory, by relative path. */
const files = (dir, here = dir) => readdirSync(here).flatMap((n) => (statSync(join(here, n)).isDirectory() ? files(dir, join(here, n)) : [relative(dir, join(here, n))])).sort();

/** The scenarios that burnt in and gate (#43): each turned `gate: true` in its own pull request. */
const GATED = new Set(['install-build', 'install-full']);

describe.each(Object.entries(SCENARIOS))('%s', (id, { feature, apps }) => {
  const s = load(id);
  const at = (step) => s.steps.indexOf(step);

  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it(`scenario.json: family install, no model, no Claude, gate only once burnt in, and ${feature}'s Apps in requirements.json`, () => {
    expect(s.scenario).toMatchObject({ id, family: 'install', tier: 'none', claude: 'none', gate: GATED.has(id) });
    expect(s.scenario.apps).toEqual(apps);
  });

  it(`phase 1, kanon: init installs --feature=${feature}, then the register is written, then init's document is held`, () => {
    expect(s.phases[0].kanon.map((x) => x.verb)).toEqual(['kanon.init', 'register.write', 'expect.init']);
    const [init] = s.ofVerb('kanon.init');
    expect(init.flags.filter((f) => f.startsWith('--feature'))).toEqual([`--feature=${feature}`]);
    expect(init.flags).toContain('--review-trigger=labelled');
    expect(init.flags.filter((f) => /^--(no-)?sensitive-data$/.test(f))).toHaveLength(1);
  });

  it('expect.init: steps-left, the findings init reports on a repository with no commit, and `/pin` equals {{release}}', () => {
    const [e] = s.ofVerb('expect.init');
    expect(e.status).toBe('steps-left');
    expect(e.findings).toEqual(['label.create', 'milestone.buckets', 'ruleset.first-commit']);
    expect(e.fields).toContainEqual({ pointer: '/pin', equals: '{{release}}' });
  });

  it('repo.apply: both calls apply what `ruleset.first-commit` leaves, the ruleset and then its `Lane check` rule', () => {
    const applies = s.ofVerb('repo.apply');
    expect(applies).toHaveLength(2);
    for (const a of applies) expect(a.firstCommit).toBe(true);
  });

  it('phase 1, act: one push of what init wrote, the bootstrap line, then the settings, apps-check, Lane check on the push, the Lane check rule, and the approval that ends bootstrap', () => {
    expect(s.phases[0].act.map((x) => x.verb)).toEqual([
      'files.commit', 'bootstrap.end', 'repo.apply', 'workflow.dispatch', 'run.await', 'expect.run', 'run.await', 'expect.check', 'repo.apply', 'bootstrap.end',
    ]);
    const [commit] = s.ofVerb('files.commit');
    expect(commit).toMatchObject({ from: 'kanon' });
    expect(commit.branch).toBeUndefined();
    const [dispatch] = s.ofVerb('workflow.dispatch');
    expect(dispatch).toMatchObject({ workflow: 'apps-check.yml' });
    const [appsRun, ciRun] = s.ofVerb('run.await');
    expect(appsRun).toMatchObject({ name: 'apps-check', workflow: 'apps-check.yml', event: 'workflow_dispatch', branch: 'main' });
    expect(ciRun).toMatchObject({ workflow: 'ci.yml', event: 'push', branch: 'main' });
    expect(s.ofVerb('expect.check')).toEqual([expect.objectContaining({ branch: 'main', name: 'Lane check', conclusion: 'success' })]);
  });

  it('pushes to the default branch only before the ruleset exists, since it lets no one bypass it', () => {
    const [firstApply] = s.ofVerb('repo.apply');
    const record = s.ofVerb('bootstrap.end').find((x) => x.move === 'record');
    for (const c of [...s.ofVerb('files.commit'), record]) expect(at(c)).toBeLessThan(at(firstApply));
    expect(s.ofVerb('pr.open')).toEqual([]);
  });

  it('ends bootstrap as an adopter does, before phase 2\'s doctor: the `ended` line in the adoption record, then one required approving review, dismissed on push (Kanon\'s docs/install.md, K-ADOPT-6)', () => {
    const ends = s.ofVerb('bootstrap.end');
    expect(ends.map((x) => x.move)).toEqual(['record', 'approval']);
    const [record, approval] = ends;
    const [commit] = s.ofVerb('files.commit');
    const [, secondApply] = s.ofVerb('repo.apply');
    expect(at(record)).toBe(at(commit) + 1);
    expect(at(approval)).toBeGreaterThan(at(secondApply));
    expect(ends.every((x) => x.phase === 1 && x.segment === 'act')).toBe(true);
    expect(at(approval)).toBeLessThan(at(s.ofVerb('kanon.doctor')[0]));
  });

  it('expect.run: the apps-check run concluded success, with a job for every App the scenario lists', () => {
    const [e] = s.ofVerb('expect.run');
    expect(e).toMatchObject({ run: 'apps-check', conclusion: 'success' });
    expect(e.jobs).toEqual(apps.map((a) => ({ name: APP_JOBS[a], conclusion: 'success' })));
  });

  it('phase 2, kanon: doctor on the kanon job\'s token reads incomplete, exit 4, only `secrets` unchecked, every pin the release under test', () => {
    expect(s.phases).toHaveLength(2);
    expect(s.phases[1].kanon.map((x) => x.verb)).toEqual(['kanon.doctor', 'expect.doctor']);
    expect(s.phases[1].act).toEqual([]);
    const [e] = s.ofVerb('expect.doctor');
    expect(e).toMatchObject({ status: 'incomplete', exitCode: 4, unchecked: ['secrets'] });
    expect(e.findings).toBeUndefined();
    expect(e.fields).toEqual(expect.arrayContaining([
      { pointer: '/releases/pins', equals: ['{{release}}'] },
      { pointer: '/releases/pinned', equals: '{{release}}' },
    ]));
  });

  it('expect.doctor: bootstrap ended, so neither its reminder nor its guard is reported, and both stay failures', () => {
    const [e] = s.ofVerb('expect.doctor');
    expect(e.absent).toEqual(expect.arrayContaining(['ruleset.bootstrap-can-end', 'ruleset.approval-off']));
  });

  it('has a README in the style of probes/README.md, and an entry in the catalogue', () => {
    const readme = s.read('README.md');
    for (const heading of ['The flags', 'The steps', 'What it creates', 'What it costs', 'When it is red']) expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    expect(readme).toContain(`--feature=${feature}`);
    const table = readme.slice(readme.indexOf('## The steps'), readme.indexOf('## What it creates'));
    expect(table).toMatch(/\| 1 \| `act` \| `bootstrap\.end` with `record`/);
    expect(table).toMatch(/\| 1 \| `act` \| `bootstrap\.end` with `approval`/);
    expect(table).toContain('`ruleset.bootstrap-can-end`');
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain(`[\`${id}/\`](scenarios/${id}/README.md)`);
  });
});

describe('install-python starts from Kanon\'s Python fixture, without its Kanon files', () => {
  const s = load('install-python');
  const start = join(s.dir, 'start');

  it('takes pyproject.toml, src/, tests/, .gitignore and the project-setup hook, and nothing else', () => {
    expect(files(start)).toEqual([
      '.github/actions/project-setup/action.yml',
      '.gitignore',
      'pyproject.toml',
      'src/orders/__init__.py',
      'src/orders/core.py',
      'tests/test_core.py',
    ]);
  });

  it('leaves out the fixture\'s Kanon callers, its register and its declarations under docs/, which init writes', () => {
    expect(existsSync(join(start, '.github/workflows'))).toBe(false);
    expect(existsSync(join(start, 'docs'))).toBe(false);
  });

  it('its README names the release it was taken from, what was taken and what was left out', () => {
    const readme = s.read('README.md');
    expect(readme).toContain('tests/fixtures/python-adopter/');
    expect(readme).toContain('candidate-v0.41.0');
    for (const left of ['.github/workflows/', 'docs/qa/agent-identities.md', 'v1.2.3']) expect(readme).toContain(left);
  });
});

describe('the docs', () => {
  it('the catalogue gives the dispatch command for the install family', () => {
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain('gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=install');
  });

  it('scenarios/README.md says where {{release}} may sit in steps.json, beside {{repository}}', () => {
    const text = readFileSync(join(ROOT, 'scenarios/README.md'), 'utf8');
    expect(text).toMatch(/\{\{release\}\}.*`fields`.*`equals`/);
  });
});
