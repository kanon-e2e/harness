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

describe.each(Object.entries(SCENARIOS))('%s', (id, { feature, apps }) => {
  const s = load(id);
  const at = (step) => s.steps.indexOf(step);

  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it(`scenario.json: family install, no model, no Claude, no gate until burn-in, and ${feature}'s Apps in requirements.json`, () => {
    expect(s.scenario).toMatchObject({ id, family: 'install', tier: 'none', claude: 'none', gate: false });
    expect(s.scenario.apps).toEqual(apps);
  });

  it(`phase 1, kanon: init installs --feature=${feature}, then the register is written, then init's document is held`, () => {
    expect(s.phases[0].kanon.map((x) => x.verb)).toEqual(['kanon.init', 'register.write', 'expect.init']);
    const [init] = s.ofVerb('kanon.init');
    expect(init.flags.filter((f) => f.startsWith('--feature'))).toEqual([`--feature=${feature}`]);
    expect(init.flags).toContain('--review-trigger=labelled');
    expect(init.flags.filter((f) => /^--(no-)?sensitive-data$/.test(f))).toHaveLength(1);
  });

  it('expect.init: steps-left, the four findings repo.apply applies, and `/pin` equals {{release}}', () => {
    const [e] = s.ofVerb('expect.init');
    expect(e.status).toBe('steps-left');
    expect(e.findings).toEqual(expect.arrayContaining(['label.create', 'milestone.buckets', 'ruleset.create', 'ruleset.require-check']));
    expect(e.fields).toContainEqual({ pointer: '/pin', equals: '{{release}}' });
  });

  it('phase 1, act: one push to the default branch, then the settings, apps-check, Lane check on the push, then the Lane check rule', () => {
    expect(s.phases[0].act.map((x) => x.verb)).toEqual([
      'files.commit', 'repo.apply', 'workflow.dispatch', 'run.await', 'expect.run', 'run.await', 'expect.check', 'repo.apply',
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
    for (const c of s.ofVerb('files.commit')) expect(at(c)).toBeLessThan(at(firstApply));
    expect(s.ofVerb('pr.open')).toEqual([]);
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
    expect(e.fields).toEqual(expect.arrayContaining([
      { pointer: '/releases/pins', equals: ['{{release}}'] },
      { pointer: '/releases/pinned', equals: '{{release}}' },
    ]));
  });

  it('has a README in the style of probes/README.md, and an entry in the catalogue', () => {
    const readme = s.read('README.md');
    for (const heading of ['The flags', 'The steps', 'What it creates', 'What it costs', 'When it is red']) expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    expect(readme).toContain(`--feature=${feature}`);
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
