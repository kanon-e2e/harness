import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateScenarioDir } from '../runner/validate.mjs';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { RELEASE, context } from './helpers/stubs.mjs';

/**
 * The doctor-broken family (Kanon plan 0012 §6.1, step E12), held to its issue's acceptance
 * criteria as data. Each scenario is `install-review`'s clean install with one thing broken, and
 * expects exactly that finding id from doctor, and no other blocking one. E12's mutation cell
 * ("as E5, per scenario": a copy whose expectation is wrong reads `fail`) is the last block: each
 * scenario's own `expect.doctor` step is run on doctor documents, and on wrong copies of itself.
 */

const ROOT = new URL('../', import.meta.url).pathname;

/** Each scenario: the finding it breaks on purpose, and how its steps differ from install-review's. */
const SCENARIOS = {
  'doctor-ruleset-rule': { finding: 'ruleset.rule-missing', category: 'ruleset', removes: ['repo.apply#2'], adds: [] },
  'doctor-approval-off': { finding: 'ruleset.approval-off', category: 'ruleset', removes: ['bootstrap.end#approval'], adds: [] },
  'doctor-id-token': { finding: 'id-token.unaccepted', category: 'id-token', removes: [], adds: [{ verb: 'files.commit', from: 'scenario', dir: 'id-token' }] },
};

const load = (id) => {
  const dir = join(ROOT, 'scenarios', id);
  const read = (path) => readFileSync(join(dir, path), 'utf8');
  const { phases } = JSON.parse(read('steps.json'));
  const steps = phases.flatMap((p, i) => [...p.kanon.map((s) => ({ ...s, phase: i + 1, segment: 'kanon' })), ...p.act.map((s) => ({ ...s, phase: i + 1, segment: 'act' }))]);
  return { dir, read, phases, steps, scenario: JSON.parse(read('scenario.json')), ofVerb: (verb) => steps.filter((s) => s.verb === verb) };
};

/** Every file under a directory, by relative path. */
const files = (dir, here = dir) => readdirSync(here).flatMap((n) => (statSync(join(here, n)).isDirectory() ? files(dir, join(here, n)) : [relative(dir, join(here, n))])).sort();

/** A step's key for comparing two scenarios' act segments: its verb, and the call it is. */
const keyed = (act) => {
  const seen = {};
  return act.map((s) => {
    seen[s.verb] = (seen[s.verb] ?? 0) + 1;
    return s.verb === 'bootstrap.end' ? `bootstrap.end#${s.move}` : `${s.verb}#${seen[s.verb]}`;
  });
};

const INSTALL = load('install-review');

describe.each(Object.entries(SCENARIOS))('%s', (id, { finding, removes, adds }) => {
  const s = load(id);
  const [expectation] = s.ofVerb('expect.doctor');

  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it('scenario.json: family doctor, no model, no Claude, the Judge, and gate: false until its burn-in', () => {
    expect(s.scenario).toEqual({ id, family: 'doctor', tier: 'none', gate: false, apps: ['judge'], claude: 'none', deadlineMinutes: 60 });
  });

  it('starts from a clean install: phase 1\'s kanon segment is install-review\'s, step for step', () => {
    expect(s.phases[0].kanon).toEqual(INSTALL.phases[0].kanon);
  });

  it('breaks one thing: its act segment is install-review\'s, less or plus only the break', () => {
    const mine = s.phases[0].act;
    const theirs = INSTALL.phases[0].act;
    const kept = theirs.filter((_, i) => !removes.includes(keyed(theirs)[i]));
    const without = mine.filter((step) => !adds.some((a) => Object.entries(a).every(([k, v]) => step[k] === v)));
    expect(without).toEqual(kept);
    expect(mine.length).toBe(theirs.length - removes.length + adds.length);
  });

  it('pushes to the default branch only before the ruleset exists, since it lets no one bypass it', () => {
    const at = (step) => s.steps.indexOf(step);
    const [firstApply] = s.ofVerb('repo.apply');
    for (const c of [...s.ofVerb('files.commit'), ...s.ofVerb('bootstrap.end').filter((x) => x.move === 'record')]) {
      expect(c.branch).toBeUndefined();
      expect(at(c)).toBeLessThan(at(firstApply));
    }
    expect(s.ofVerb('pr.open')).toEqual([]);
  });

  it(`phase 2: doctor on the kanon job's token reads findings, exit 1, only \`secrets\` unchecked, and \`${finding}\` the one blocking finding`, () => {
    expect(s.phases).toHaveLength(2);
    expect(s.phases[1].kanon.map((x) => x.verb)).toEqual(['kanon.doctor', 'expect.doctor']);
    expect(s.phases[1].act).toEqual([]);
    expect(expectation).toMatchObject({ status: 'findings', exitCode: 1, unchecked: ['secrets'], findings: [finding], blocking: [finding] });
    expect(expectation.fields).toEqual([
      { pointer: '/releases/pins', equals: ['{{release}}'] },
      { pointer: '/releases/pinned', equals: '{{release}}' },
    ]);
  });

  it('has a README in the house style, which names the break and the finding, and an entry in the catalogue', () => {
    const readme = s.read('README.md');
    for (const heading of ['What the repository holds', 'The flags', 'The steps', 'What it creates', 'What it costs', 'When it is red']) expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    expect(readme).toContain('Kanon\'s plan 0012 step E12');
    expect(readme).toContain('`gate: false`');
    const table = readme.slice(readme.indexOf('## The steps'), readme.indexOf('## What it creates'));
    expect(table).toContain('**The break:**');
    expect(table).toContain(`\`${finding}\``);
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain(`[\`${id}/\`](scenarios/${id}/README.md)`);
  });
});

describe('doctor-id-token\'s break', () => {
  const s = load('doctor-id-token');
  const tree = join(s.dir, 'id-token');
  const workflow = parse(readFileSync(join(tree, '.github/workflows/publish.yml'), 'utf8'));

  it('is one workflow, and start/ holds nothing but the README', () => {
    expect(files(tree)).toEqual(['.github/workflows/publish.yml']);
    expect(files(join(s.dir, 'start'))).toEqual(['README.md']);
  });

  it('is a job of the adopter\'s own holding id-token: write in its own permissions, with nothing at the workflow level', () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(['publish']);
    expect(workflow.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('runs only when dispatched, which the scenario never does, and calls nothing: no Kanon workflow, no action, no secret', () => {
    expect(workflow.on).toBe('workflow_dispatch');
    expect(s.ofVerb('workflow.dispatch').map((d) => d.workflow)).toEqual(['apps-check.yml']);
    const text = readFileSync(join(tree, '.github/workflows/publish.yml'), 'utf8');
    expect(text).not.toMatch(/uses:|secrets\.|yedeya-labs\/kanon/);
  });
});

describe('E12\'s mutation: a copy of a scenario whose expectation is wrong reads fail', () => {
  const run = (step, document, exit = document.exitCode) => VOCABULARY['expect.doctor'].run(step, context({ state: { documents: { doctor: { release: RELEASE, exit, document } } } }));
  const fails = { name: 'Fail' };

  /** Doctor's document on the kanon job's read-only token, with these findings (probe 19's `secrets` unchecked). */
  const doc = (findings) => {
    const blocking = findings.some((f) => f.blocking);
    return {
      schema: 'kanon-doctor/v1', kanon: 'v0.41.0', status: blocking ? 'findings' : 'incomplete', exitCode: blocking ? 1 : 4,
      releases: { pins: [RELEASE], pinned: RELEASE }, findings, waived: [],
      unchecked: [{ check: 'secrets', subject: 'kanon-e2e/e2e-sample-123-1', reason: 'the token can\'t list the repository\'s secrets' }],
    };
  };
  /** A finding as doctor writes one: an id, its category, whether it blocks, and prose no expectation reads. */
  const f = (id, blocking) => ({ id, category: id.split('.')[0], blocking, subject: 'main', message: 'prose', fix: { text: 'prose' } });
  /** What a candidate's doctor reports beside the break, and blocks nothing. */
  const NOTE = f('pin.candidate', false);

  describe.each(Object.entries(SCENARIOS))('%s', (id, { finding, category }) => {
    const [step] = load(id).ofVerb('expect.doctor');
    const broken = doc([NOTE, { ...f(finding, true), category }]);

    it(`passes on doctor's document when the break is reported: \`${finding}\` blocking, beside a finding that blocks nothing`, async () => {
      await run(step, broken);
    });

    it('fails on the clean install\'s document, where the break is missing: incomplete, exit 4, nothing blocking', async () => {
      await expect(run(step, doc([NOTE]))).rejects.toMatchObject(fails);
    });

    it('fails a copy that expects a finding doctor doesn\'t report', async () => {
      const wrong = finding === 'label.missing' ? 'ruleset.missing' : 'label.missing';
      await expect(run({ ...step, findings: [wrong] }, broken)).rejects.toMatchObject(fails);
      await expect(run({ ...step, findings: [finding, wrong], blocking: [finding, wrong] }, broken)).rejects.toMatchObject(fails);
    });

    it('fails a copy that expects healthy, or incomplete with exit 4, as the install scenarios do', async () => {
      await expect(run({ ...step, status: 'incomplete', exitCode: 4 }, broken)).rejects.toMatchObject(fails);
      await expect(run({ ...step, status: 'healthy', exitCode: 0 }, broken)).rejects.toMatchObject(fails);
    });

    it('fails when doctor blocks on a second finding beside the break, or reports the break as not blocking', async () => {
      await expect(run(step, doc([NOTE, f(finding, true), f('caller.grant-missing', true)]))).rejects.toMatchObject(fails);
      await expect(run(step, doc([NOTE, f(finding, false)]))).rejects.toMatchObject(fails);
    });

    it('fails when another check is unchecked, or the break is reported at another release', async () => {
      await expect(run(step, { ...broken, unchecked: [...broken.unchecked, { check: 'ruleset', subject: 'main', reason: 'r' }] })).rejects.toMatchObject(fails);
      await expect(run(step, { ...broken, releases: { pins: ['v0.40.2'], pinned: 'v0.40.2' } })).rejects.toMatchObject(fails);
    });
  });
});

describe('the docs', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  it('the catalogue describes the doctor family, its gate: false, and gives its dispatch command', () => {
    expect(readme).toContain('**The doctor-broken family**');
    expect(readme).toContain('gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=doctor');
  });

  it('the README\'s list of tests names this file', () => {
    expect(readme).toContain('`tests/doctor-scenarios.test.mjs`');
  });

  it('scenarios/README.md documents expect.doctor\'s `blocking`', () => {
    const text = readFileSync(join(ROOT, 'scenarios/README.md'), 'utf8');
    const row = text.split('\n').find((l) => l.startsWith('| `expect.doctor` |'));
    expect(row).toContain('`blocking`');
  });
});
