import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUBSTITUTION } from '../runner/lib/substitute.mjs';
import { layStart } from '../runner/run.mjs';
import { scenarioDirs, validateScenarioDir, validateScenarioJson, validateStart, validateSteps } from '../runner/validate.mjs';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { RELEASE, scenarioJson, tempDir, writeScenario, writeTree } from './helpers/stubs.mjs';

/**
 * The scenario format (Kanon plan 0012 §4, step E3): `scenario.json` field by field (§4.1), the
 * two substitutions of `start/`, `steps.json` as up to three phases of a `kanon` segment then an
 * `act` segment (§5.2), the closed vocabulary with each verb's segment kind (§4.2), a deadline on
 * every verb that waits (§10), and the rule that expectations read fields, finding ids and known
 * markers, never prose (§4.3). The runner (E4) reads scenarios only through this validator.
 */

/** `steps.json` with one phase. */
const onePhase = (kanon = [], act = []) => ({ phases: [{ kanon, act }] });
/** The errors of one step placed in a segment. */
const stepErrors = (step, segment = 'act', before = []) =>
  validateSteps(segment === 'act' ? onePhase([{ verb: 'kanon.init' }, { verb: 'kanon.doctor' }], [...before, step]) : onePhase([{ verb: 'kanon.init' }, { verb: 'kanon.doctor' }, ...before, step], []));

describe('every directory under scenarios/ validates', () => {
  const dirs = scenarioDirs('scenarios');
  it.each(dirs.length ? dirs : ['(none yet)'])('%s', (dir) => {
    if (dir === '(none yet)') return;
    expect(validateScenarioDir(dir)).toEqual([]);
  });

  it('finds a scenario directory where there is one, so the check above is not vacuous by construction', () => {
    const dir = writeScenario({ id: 'found-me' });
    expect(scenarioDirs(join(dir, '..'))).toEqual([dir]);
    expect(validateScenarioDir(dir)).toEqual([]);
  });

  it('accepts a scenario that uses every verb of the vocabulary in its kind of segment', () => {
    const dir = writeScenario({ id: 'every-verb', steps: EVERY_VERB, extra: { 'files/fix/docs/a.md': 'a\n' } });
    expect(validateScenarioDir(dir)).toEqual([]);
    const used = new Set(EVERY_VERB.phases.flatMap((p) => [...p.kanon, ...p.act]).map((s) => s.verb));
    expect([...used].sort()).toEqual(Object.keys(VOCABULARY).sort());
  });
});

describe('scenario.json, field by field (§4.1)', () => {
  it('accepts the fields as §4.1 states them', () => {
    expect(validateScenarioJson(scenarioJson('install-full-2'), 'install-full-2')).toEqual([]);
    expect(validateScenarioJson(scenarioJson('x', { apps: [], tier: 'model', claude: 'subscription', gate: true, deadlineMinutes: 120 }), 'x')).toEqual([]);
  });

  it.each([
    ['an id other than the directory\'s name', { id: 'other' }, /id/],
    ['an id with a capital', { id: 'Sample' }, /id/],
    ['an id with an underscore', { id: 'sam_ple' }, /id/],
    ['an id over 40 characters', { id: 'a'.repeat(41) }, /id/],
    ['an unknown family', { family: 'smoke' }, /family/],
    ['an unknown tier', { tier: 'stub' }, /tier/],
    ['a gate that isn\'t a boolean', { gate: 'false' }, /gate/],
    ['an unknown App', { apps: ['author', 'reporter'] }, /apps/],
    ['an App twice', { apps: ['author', 'author'] }, /apps/],
    ['apps not a list', { apps: 'author' }, /apps/],
    ['claude as the old api-key', { claude: 'api-key' }, /claude/],
    ['a deadline over 120 minutes', { deadlineMinutes: 121 }, /deadlineMinutes/],
    ['a deadline that isn\'t a whole number', { deadlineMinutes: 30.5 }, /deadlineMinutes/],
    ['a field §4.1 doesn\'t name', { owner: 'x' }, /owner/],
  ])('refuses %s', (_, over, error) => {
    const id = 'id' in over ? over.id : 'sample';
    const errors = validateScenarioJson({ ...scenarioJson('sample'), ...over }, 'sample');
    expect(errors.join('\n')).toMatch(error);
    if (id === 'sample') expect(errors.length).toBe(1);
  });

  it('refuses a field named after one every object inherits (constructor, toString, __proto__)', () => {
    for (const k of ['constructor', 'toString', '__proto__']) {
      const s = JSON.parse(JSON.stringify(scenarioJson('sample')).replace(/^\{/, `{"${k}":"not a field",`));
      expect(validateScenarioJson(s, 'sample'), k).toEqual([`\`${k}\` is not a field of scenario.json (Kanon plan 0012 §4.1)`]);
    }
  });

  it('refuses a missing field by name', () => {
    const { tier: _, ...rest } = scenarioJson('sample');
    expect(validateScenarioJson(rest, 'sample').join('\n')).toMatch(/tier/);
  });

  it('accepts an id of exactly 40 characters', () => {
    const id = `a${'-b'.repeat(19)}c`;
    expect(id.length).toBe(40);
    expect(validateScenarioJson(scenarioJson(id), id)).toEqual([]);
  });
});

describe('scenario.json\'s `runsOn`: the kinds of run a scenario takes part in (#139)', () => {
  it('takes any non-empty set of `candidate`, `dispatch` and `scheduled`, and leaving it out is every kind', () => {
    for (const runsOn of [['candidate'], ['dispatch'], ['scheduled'], ['candidate', 'dispatch'], ['candidate', 'dispatch', 'scheduled']]) {
      expect(validateScenarioJson(scenarioJson('sample', { runsOn }), 'sample'), runsOn.join()).toEqual([]);
    }
    expect(validateScenarioJson(scenarioJson('sample'), 'sample')).toEqual([]);
  });

  it.each([
    ['an empty list', [], /`runsOn` must be a non-empty list of strings/],
    ['an unknown kind', ['nightly'], /each of `runsOn` must be one of `candidate`, `dispatch`, `scheduled`, not `nightly`/],
    ['a kind twice', ['dispatch', 'dispatch'], /`runsOn` names something twice/],
    ['a string, not a list', 'dispatch', /`runsOn` must be a non-empty list of strings/],
  ])('refuses %s', (_, runsOn, error) => {
    const errors = validateScenarioJson(scenarioJson('sample', { runsOn }), 'sample');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(error);
  });

  it('refuses `gate: true` with a `runsOn` that leaves out `candidate`: a gating scenario must be in the candidate\'s run it gates', () => {
    for (const runsOn of [['dispatch'], ['scheduled'], ['dispatch', 'scheduled']]) {
      expect(validateScenarioJson(scenarioJson('sample', { gate: true, runsOn }), 'sample'), runsOn.join()).toEqual([
        '`gate: true` gates a candidate, and `runsOn` leaves out `candidate`: the candidate\'s run would never hold the scenario',
      ]);
    }
    expect(validateScenarioJson(scenarioJson('sample', { gate: true, runsOn: ['candidate'] }), 'sample')).toEqual([]);
    expect(validateScenarioJson(scenarioJson('sample', { gate: false, runsOn: ['dispatch'] }), 'sample')).toEqual([]);
  });
});

describe('start/: copied as it is, with two substitutions and no others (§4.1)', () => {
  const start = (files) => validateStart(writeTree(tempDir(), files));

  it('accepts {{release}} and {{repository}}, and the workflow expressions GitHub reads', () => {
    expect(start({
      'README.md': 'Kanon {{release}} in {{repository}}.\n',
      '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: yedeya-labs/kanon/actions/lane-check@{{release}}\n      - run: echo ${{ github.sha }} ${{secrets.X}}\n',
    })).toEqual([]);
  });

  it.each([
    ['another name', 'Pinned to {{version}}.'],
    ['a spaced name', 'Pinned to {{ release }}.'],
    ['an empty one', 'Pinned to {{}}.'],
    ['a dotted one', 'From {{scenario.id}}.'],
  ])('refuses a substitution with %s', (_, text) => {
    expect(start({ 'docs/a.md': text }).join('\n')).toMatch(/docs\/a\.md.*substitution/);
  });

  it('refuses a substitution in a path', () => {
    expect(start({ 'docs/{{owner}}.md': 'x' }).join('\n')).toMatch(/substitution/);
  });

  it('refuses a symlink, and an empty or missing start/', () => {
    const dir = writeTree(tempDir(), { 'a.md': 'a' });
    symlinkSync('/etc/passwd', join(dir, 'link'));
    expect(validateStart(dir).join('\n')).toMatch(/link.*regular file/);
    const empty = tempDir();
    expect(validateStart(empty).join('\n')).toMatch(/no file/);
    expect(validateStart(join(empty, 'missing')).join('\n')).toMatch(/missing/);
  });

  it('reads a binary file as data, not as text to substitute', () => {
    expect(start({ 'img.bin': `\u0000{{anything}}` })).toEqual([]);
  });
});

describe('start/ and files.commit share one substitution, runner/lib/substitute.mjs (#95)', () => {
  const RUNNER = join(import.meta.dirname, '..', 'runner');
  const SHARED = join('lib', 'substitute.mjs');
  const modules = (dir, rel = '') => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = join(rel, e.name);
    if (e.isDirectory()) return modules(dir, r);
    return e.name.endsWith('.mjs') ? [r] : [];
  });

  it('defines the two and their pattern only in lib/substitute.mjs', () => {
    const others = modules(RUNNER).filter((r) => r !== SHARED);
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) {
      const text = readFileSync(join(RUNNER, r), 'utf8');
      expect(text, r).not.toContain(SUBSTITUTION.source);
      expect(text, r).not.toMatch(/\bSUBSTITUTIONS\s*=|\bSUBSTITUTION\s*=|\bconst (substitute|substituteBytes|strangers)\s*=/);
    }
  });

  it.each([['validate.mjs'], ['run.mjs'], [join('verbs', 'files-commit.mjs')]])('%s imports it', (r) => {
    expect(readFileSync(join(RUNNER, r), 'utf8')).toMatch(/from '\.\.?\/lib\/substitute\.mjs'/);
  });

  it('layStart fills in the two in paths and text, and leaves a workflow expression, another name and a binary file as they are', () => {
    const src = writeTree(tempDir(), {
      'docs/{{repository}}.md': 'Kanon {{release}} in {{repository}}, ${{ github.sha }}, {{version}}.\n',
      'img.bin': '\u0000{{release}}',
    });
    const dest = tempDir();
    layStart(src, dest, { release: RELEASE, repository: 'o/r' });
    expect(readFileSync(join(dest, 'docs', 'o', 'r.md'), 'utf8')).toBe(`Kanon ${RELEASE} in o/r, \${{ github.sha }}, {{version}}.\n`);
    expect(readFileSync(join(dest, 'img.bin'), 'utf8')).toBe('\u0000{{release}}');
  });
});

describe('steps.json: up to three phases, each a kanon segment then an act segment (§5.2)', () => {
  it('accepts one, two and three phases', () => {
    for (const n of [1, 2, 3]) {
      const phases = Array.from({ length: n }, () => ({ kanon: [{ verb: 'kanon.doctor' }], act: [] }));
      expect(validateSteps({ phases })).toEqual([]);
    }
  });

  it('refuses a steps.json that needs a fourth phase', () => {
    const phases = Array.from({ length: 4 }, () => ({ kanon: [{ verb: 'kanon.doctor' }], act: [] }));
    expect(validateSteps({ phases }).join('\n')).toMatch(/more than three phases/);
  });

  it.each([
    ['no phases', { phases: [] }, /at least one phase/],
    ['phases not a list', { phases: {} }, /phases/],
    ['a key beside phases', { phases: [{ kanon: [], act: [{ verb: 'pr.open', name: 'a', head: 'b', title: 't' }] }], env: {} }, /env/],
    ['a phase without its act segment', { phases: [{ kanon: [{ verb: 'kanon.doctor' }] }] }, /act/],
    ['a phase with a third segment', { phases: [{ kanon: [], act: [], model: [] }] }, /model/],
    ['a phase with no step at all', { phases: [{ kanon: [], act: [] }] }, /no step/],
    ['a segment that isn\'t a list', { phases: [{ kanon: { verb: 'kanon.doctor' }, act: [] }] }, /kanon/],
    ['a step without a verb', { phases: [{ kanon: [{ name: 'x' }], act: [] }] }, /verb/],
  ])('refuses %s', (_, steps, error) => {
    expect(validateSteps(steps).join('\n')).toMatch(error);
  });
});

describe('the closed vocabulary, each verb in its kind of segment (§4.2)', () => {
  it('refuses an unknown verb', () => {
    expect(stepErrors({ verb: 'shell.run', command: 'curl …' }).join('\n')).toMatch(/unknown verb `shell\.run`/);
    expect(stepErrors({ verb: 'kanon.upgrade' }, 'kanon').join('\n')).toMatch(/unknown verb `kanon\.upgrade`/);
  });

  it('refuses a verb named after a property every object inherits as unknown, rather than throwing', () => {
    for (const verb of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(stepErrors({ verb }).join('\n'), verb).toMatch(new RegExp(`unknown verb \`${verb}\``));
    }
  });

  it('refuses an act verb in a kanon segment', () => {
    const errors = stepErrors({ verb: 'pr.open', name: 'docs', head: 'docs', title: 'Docs' }, 'kanon');
    expect(errors.join('\n')).toMatch(/`pr\.open` writes to GitHub with the harness's code, so it belongs only in an `act` segment/);
  });

  it('refuses repo.apply in a kanon segment: the kanon job\'s token is read-only (decision 23 (b))', () => {
    expect(stepErrors({ verb: 'repo.apply' }, 'kanon').join('\n')).toMatch(/`repo\.apply`.*only in an `act` segment/);
  });

  it('refuses a kanon verb in an act segment', () => {
    expect(stepErrors({ verb: 'kanon.doctor' }, 'act').join('\n')).toMatch(/`kanon\.doctor` runs Kanon's code, so it belongs only in a `kanon` segment/);
    expect(stepErrors({ verb: 'pins.move' }, 'act').join('\n')).toMatch(/only in a `kanon` segment/);
    expect(stepErrors({ verb: 'register.write' }, 'act').join('\n')).toMatch(/only in a `kanon` segment/);
  });

  it('accepts a reading verb in either kind of segment', () => {
    for (const segment of ['kanon', 'act']) {
      expect(stepErrors({ verb: 'expect.doctor', status: 'healthy' }, segment)).toEqual([]);
      expect(stepErrors({ verb: 'run.await', workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 10 }, segment)).toEqual([]);
    }
  });

  it('refuses a waiting verb with no deadline', () => {
    expect(stepErrors({ verb: 'run.await', workflow: 'ci.yml', event: 'push', branch: 'main' }).join('\n')).toMatch(/`run\.await` waits, so it needs a `deadline` in minutes/);
    expect(stepErrors({ verb: 'release.cut' }).join('\n')).toMatch(/needs a `deadline`/);
  });

  it('refuses a deadline that isn\'t a whole number of minutes from 1 to 120', () => {
    for (const deadline of [0, 121, 2.5, '10']) {
      expect(stepErrors({ verb: 'release.cut', deadline }).join('\n')).toMatch(/deadline/);
    }
  });

  it('refuses a deadline on a verb that doesn\'t wait', () => {
    expect(stepErrors({ verb: 'issue.open', name: 'a', title: 'A', deadline: 5 }).join('\n')).toMatch(/`deadline`/);
  });

  it('refuses an argument the verb doesn\'t take, and a missing one it needs', () => {
    expect(stepErrors({ verb: 'issue.open', name: 'a', title: 'A', assignee: 'x' }).join('\n')).toMatch(/`assignee`/);
    expect(stepErrors({ verb: 'issue.open', name: 'a' }).join('\n')).toMatch(/`title`/);
  });

  it('refuses an argument named after a property every object inherits (constructor, toString, __proto__)', () => {
    for (const k of ['constructor', 'toString', 'valueOf', '__proto__']) {
      const step = JSON.parse(`{"verb":"issue.open","name":"a","title":"A","${k}":"free text"}`);
      expect(stepErrors(step), k).toEqual([`phases[0].act[0] \`issue.open\`: \`${k}\` is not an argument it takes`]);
    }
  });

  it('refuses a reference to a pull request, issue, run or document no earlier step made', () => {
    expect(stepErrors({ verb: 'pr.label', pr: 'nope', add: ['x'] }).join('\n')).toMatch(/`nope`/);
    expect(stepErrors({ verb: 'expect.run', run: 'ci', conclusion: 'success', deadline: 5 }).join('\n')).toMatch(/`ci`/);
    expect(validateSteps(onePhase([{ verb: 'expect.doctor', status: 'healthy' }])).join('\n')).toMatch(/no earlier `kanon\.doctor`/);
    expect(validateSteps(onePhase([], [{ verb: 'repo.apply' }])).join('\n')).toMatch(/no earlier `kanon\.init`/);
  });

  it('refuses a third repo.apply: the first applies the settings, the second the Lane check rule', () => {
    const apply = { verb: 'repo.apply' };
    expect(validateSteps(onePhase([{ verb: 'kanon.init' }], [apply, apply]))).toEqual([]);
    expect(validateSteps(onePhase([{ verb: 'kanon.init' }], [apply, apply, apply])).join('\n')).toMatch(/at most twice/);
  });

  it('refuses bootstrap.end\'s approval before its record, and either move twice: once the ruleset requires an approval, no push reaches the default branch without one', () => {
    const record = { verb: 'bootstrap.end', move: 'record' };
    const approval = { verb: 'bootstrap.end', move: 'approval' };
    expect(validateSteps(onePhase([], [record, approval]))).toEqual([]);
    expect(validateSteps(onePhase([], [approval])).join('\n')).toMatch(/`approval`.*no earlier `record`/);
    expect(validateSteps(onePhase([], [approval, record])).join('\n')).toMatch(/`approval`.*no earlier `record`/);
    expect(validateSteps(onePhase([], [record, record, approval])).join('\n')).toMatch(/`record` runs once/);
    expect(validateSteps(onePhase([], [record, approval, approval])).join('\n')).toMatch(/`approval` runs once/);
    expect(stepErrors({ verb: 'bootstrap.end' }, 'act').join('\n')).toMatch(/`move`/);
    expect(stepErrors({ verb: 'bootstrap.end', move: 'record' }, 'kanon').join('\n')).toMatch(/only in an `act` segment/);
  });

  it('starts repo.apply\'s count again at each new init document, from kanon.init or kanon.at\'s init, and at no other step', () => {
    const apply = { verb: 'repo.apply' };
    const upgrade = (again, act) => ({ phases: [{ kanon: [{ verb: 'kanon.at', release: 'previous', command: 'init' }], act: [apply, apply] }, { kanon: [{ verb: 'kanon.doctor', to: true }, ...again], act }] });
    expect(validateSteps(upgrade([{ verb: 'kanon.init' }], [apply, apply]))).toEqual([]);
    expect(validateSteps(upgrade([{ verb: 'kanon.at', release: 'v0.40.2', command: 'init' }], [apply, apply]))).toEqual([]);
    expect(validateSteps(upgrade([{ verb: 'kanon.init' }], [apply, apply, apply])).join('\n')).toMatch(/at most twice/);
    expect(validateSteps(upgrade([{ verb: 'kanon.at', release: 'v0.40.2', command: 'doctor' }], [apply])).join('\n')).toMatch(/at most twice/);
    expect(validateSteps(upgrade([], [apply])).join('\n')).toMatch(/at most twice/);
  });

  it('takes register.write\'s release as kanon.at takes it: previous, previous-1 or an exact release', () => {
    for (const release of ['previous', 'previous-1', 'v0.40.2', 'candidate-v0.41.0']) expect(stepErrors({ verb: 'register.write', release }, 'kanon')).toEqual([]);
    for (const release of ['previous-2', 'main', 'v0.40']) expect(stepErrors({ verb: 'register.write', release }, 'kanon').join('\n')).toMatch(/`release`/);
  });

  it('refuses kanon.init flags that would undo what the verb fixes: JSON, no Apps, telemetry and sharing declined', () => {
    for (const flag of ['--telemetry', '--consent=yes', '--upstream-findings=sent', '--create-apps', '--dry-run', '--help']) {
      expect(stepErrors({ verb: 'kanon.init', flags: [flag] }, 'kanon').join('\n')).toMatch(/flag/);
    }
    expect(stepErrors({ verb: 'kanon.init', flags: ['--feature full'] }, 'kanon').join('\n')).toMatch(/--flag=value/);
    expect(stepErrors({ verb: 'kanon.init', flags: ['--feature=full', '--review-trigger=labelled', '--sensitive-data'] }, 'kanon')).toEqual([]);
  });

  it('refuses a files.commit directory outside the scenario\'s own', () => {
    const dir = writeScenario({ steps: onePhase([], [{ verb: 'files.commit', from: 'scenario', dir: '../other', message: 'm' }]) });
    expect(validateScenarioDir(dir).join('\n')).toMatch(/dir/);
    const missing = writeScenario({ steps: onePhase([], [{ verb: 'files.commit', from: 'scenario', dir: 'files/none', message: 'm' }]) });
    expect(validateScenarioDir(missing).join('\n')).toMatch(/files\/none/);
  });

  it('takes {{release}} and {{repository}} in a files.commit directory, as start/ does, and refuses any other substitution there', () => {
    const steps = onePhase([], [{ verb: 'files.commit', from: 'scenario', dir: 'files/fix', branch: 'fix', message: 'm' }]);
    const two = writeScenario({ steps, extra: { 'files/fix/a.yml': 'uses: x@{{release}} in {{repository}}, ${{ secrets.A }}\n' } });
    expect(validateScenarioDir(two)).toEqual([]);
    const other = writeScenario({ steps, extra: { 'files/fix/a.yml': 'uses: x@{{version}}\n' } });
    expect(validateScenarioDir(other).join('\n')).toMatch(/files\/fix\/a\.yml.*\{\{version\}\} is not one of the two/);
    const inPath = writeScenario({ steps, extra: { 'files/fix/{{owner}}.md': 'x\n' } });
    expect(validateScenarioDir(inPath).join('\n')).toMatch(/\{\{owner\}\} is not one of the two/);
  });
});

describe('expect.api reads only the scenario repository\'s own API (§4.2)', () => {
  const api = (path, pointer = '/allow_squash_merge') => stepErrors({ verb: 'expect.api', path, pointer, equals: true, deadline: 5 });

  it('accepts a path under repos/{{repository}}/', () => {
    expect(api('repos/{{repository}}')).not.toEqual([]);
    expect(api('repos/{{repository}}/rulesets?per_page=100', '/0/name')).toEqual([]);
    expect(api('repos/{{repository}}/branches/main', '/protected')).toEqual([]);
  });

  it.each([
    ['another owner\'s repository', 'repos/yedeya-labs/kanon/releases'],
    ['another repository named outright', 'repos/kanon-e2e/harness/issues'],
    ['a path that climbs out', 'repos/{{repository}}/../../yedeya-labs/kanon'],
    ['an encoded climb', 'repos/{{repository}}/%2e%2e/x'],
    ['a path outside repos/', 'orgs/kanon-e2e/repos'],
    ['an absolute URL', 'https://api.github.com/repos/{{repository}}/pulls'],
    ['the release substituted in', 'repos/{{release}}/pulls'],
    ['an empty segment', 'repos/{{repository}}//pulls'],
  ])('refuses %s', (_, path) => {
    expect(api(path).join('\n')).toMatch(/`expect\.api` reads only the scenario repository's own API/);
  });
});

describe('expectations read a field, a finding id or a known marker, never prose (§4.3)', () => {
  it('refuses an expectation that matches a finding\'s message', () => {
    const errors = stepErrors({ verb: 'expect.doctor', fields: [{ pointer: '/findings/0/message', equals: 'The ruleset is missing.' }] });
    expect(errors.join('\n')).toMatch(/`\/findings\/0\/message` reads `message`, a field that holds free text/);
  });

  it.each([
    ['a comment\'s body', 'expect.api', '/0/body'],
    ['a finding\'s fix', 'expect.init', '/findings/0/fix/text'],
    ['doctor\'s notes', 'expect.doctor', '/notes/0'],
    ['a check run\'s output', 'expect.api', '/check_runs/0/output/summary'],
    ['an issue\'s title', 'expect.api', '/title'],
    ['a workflow run\'s display title', 'expect.api', '/workflow_runs/0/display_title'],
    ['a comment\'s body as text', 'expect.api', '/0/body_text'],
    ['a comment\'s body as HTML', 'expect.api', '/0/body_html'],
  ])('refuses one that reads %s', (_, verb, pointer) => {
    const step = verb === 'expect.api'
      ? { verb, path: 'repos/{{repository}}/issues/1', pointer, equals: 'x', deadline: 5 }
      : { verb, fields: [{ pointer, equals: 'x' }] };
    expect(stepErrors(step).join('\n')).toMatch(/free text/);
  });

  it('refuses free text to match: any argument that isn\'t a field, a finding id or a marker', () => {
    for (const [verb, extra] of [
      ['expect.doctor', { contains: 'ruleset' }],
      ['expect.doctor', { message: 'missing' }],
      ['expect.pr', { pr: 'docs', bodyMatches: 'LGTM', deadline: 5 }],
      ['expect.issue', { issue: 'bug', comment: 'Reproduced', deadline: 5 }],
      ['expect.run', { run: 'ci', logContains: 'ok', deadline: 5 }],
    ]) {
      const errors = stepErrors({ verb, ...extra }, 'act', OPENED);
      expect(errors.join('\n'), `${verb} ${JSON.stringify(extra)}`).toMatch(/names only a JSON field, a finding id or a known marker/);
    }
  });

  it('refuses free text under a name every object inherits (valueOf, constructor, __proto__), and a substitution there, rather than throwing', () => {
    for (const k of ['valueOf', 'constructor', '__proto__']) {
      const step = JSON.parse(`{"verb":"expect.issue","issue":"bug","deadline":5,"${k}":"free text to match"}`);
      expect(stepErrors(step, 'act', OPENED).join('\n'), k).toMatch(new RegExp(`\`${k}\` is not something an expectation may name`));
      const api = JSON.parse(`{"verb":"expect.api","path":"repos/{{repository}}/issues/1","pointer":"/state","equals":"open","deadline":5,"${k}":"{{release}}"}`);
      expect(stepErrors(api).join('\n'), k).toMatch(/the substitution \{\{release\}\} is not taken here/);
    }
  });

  it('refuses a marker that isn\'t on the harness\'s list of known markers', () => {
    expect(stepErrors({ verb: 'expect.pr', pr: 'docs', marker: 'role:reviewer', deadline: 5 }, 'act', OPENED)).toEqual([]);
    expect(stepErrors({ verb: 'expect.pr', pr: 'docs', marker: 'e2e-test-marker', deadline: 5 }, 'act', OPENED).join('\n')).toMatch(/not a known marker/);
    expect(stepErrors({ verb: 'expect.pr', pr: 'docs', marker: '<!-- kanon:role=reviewer -->', deadline: 5 }, 'act', OPENED).join('\n')).toMatch(/not a known marker/);
  });

  it('refuses a finding id or an unchecked check that isn\'t an id', () => {
    expect(stepErrors({ verb: 'expect.doctor', findings: ['The ruleset is missing'] }).join('\n')).toMatch(/finding id/);
    expect(stepErrors({ verb: 'expect.doctor', unchecked: ['the secrets'] }).join('\n')).toMatch(/unchecked/);
    expect(stepErrors({ verb: 'expect.doctor', blocking: ['The ruleset lacks a rule'] }).join('\n')).toMatch(/blocking.*finding id|finding id/s);
    expect(stepErrors({ verb: 'expect.init', blocking: ['ruleset.missing'] }).join('\n')).toMatch(/blocking/);
  });

  it('accepts a doctor-broken expectation: findings, exit 1, `secrets` unchecked, and exactly one blocking finding id (E12)', () => {
    expect(stepErrors({ verb: 'expect.doctor', status: 'findings', exitCode: 1, unchecked: ['secrets'], findings: ['ruleset.rule-missing'], blocking: ['ruleset.rule-missing'] }, 'kanon')).toEqual([]);
  });

  it('refuses a pointer that isn\'t one, and a value that is an object, which could carry free text', () => {
    expect(stepErrors({ verb: 'expect.init', fields: [{ pointer: 'pin', equals: 'x' }] }).join('\n')).toMatch(/pointer/);
    expect(stepErrors({ verb: 'expect.init', fields: [{ pointer: '', equals: 'x' }] }).join('\n')).toMatch(/pointer/);
    expect(stepErrors({ verb: 'expect.init', fields: [{ pointer: '/findings/0', equals: { id: 'x' } }] }).join('\n')).toMatch(/equals/);
    expect(stepErrors({ verb: 'expect.init', fields: [{ pointer: '/pin', equals: 'candidate-v0.41.0' }, { pointer: '/findings', equals: [] }] })).toEqual([]);
  });

  it('accepts what probe 19 measured: doctor on the kanon job\'s token, exit 4, `secrets` allowed unchecked', () => {
    expect(stepErrors({ verb: 'expect.doctor', status: 'incomplete', exitCode: 4, unchecked: ['secrets'], absent: ['ruleset.missing'] }, 'kanon')).toEqual([]);
  });
});

describe('substitutions in steps.json', () => {
  it('refuses any other than {{repository}} in expect.api\'s path', () => {
    expect(stepErrors({ verb: 'issue.open', name: 'a', title: 'Bump to {{release}}' }).join('\n')).toMatch(/substitution/);
  });

  it.each(['expect.init', 'expect.doctor'])('accepts {{release}} in a `fields` entry\'s `equals` of %s, a string or in a list', (verb) => {
    const fields = [{ pointer: '/releases/pinned', equals: '{{release}}' }, { pointer: '/releases/pins', equals: ['{{release}}'] }];
    expect(stepErrors({ verb, fields, ...(verb === 'expect.doctor' ? { unchecked: ['secrets'] } : {}) }, 'kanon')).toEqual([]);
  });

  it.each([
    ['in a `fields` entry\'s pointer', { verb: 'expect.init', fields: [{ pointer: '/{{release}}', equals: 'x' }] }],
    ['{{repository}} in a `fields` entry\'s equals', { verb: 'expect.init', fields: [{ pointer: '/pin', equals: '{{repository}}' }] }],
    ['an unknown one in a `fields` entry\'s equals', { verb: 'expect.doctor', fields: [{ pointer: '/releases/pinned', equals: '{{owner}}' }] }],
    ['in expect.api\'s equals', { verb: 'expect.api', path: 'repos/{{repository}}/', pointer: '/name', equals: '{{release}}', deadline: 1 }],
    ['in expect.api\'s pointer', { verb: 'expect.api', path: 'repos/{{repository}}/', pointer: '/{{release}}', equals: 'x', deadline: 1 }],
    ['in kanon.init\'s flags', { verb: 'kanon.init', flags: ['--project-owner={{release}}'] }],
    ['in workflow.dispatch\'s inputs', { verb: 'workflow.dispatch', workflow: 'ci.yml', inputs: { release: '{{release}}' } }],
    ['in expect.issue\'s labels', { verb: 'expect.issue', issue: 'bug', labels: ['{{release}}'], deadline: 1 }],
  ])('still refuses {{release}} anywhere else new: %s', (_, step) => {
    const segment = step.verb === 'kanon.init' ? 'kanon' : 'act';
    expect(stepErrors(step, segment, step.verb === 'expect.issue' ? OPENED : []).join('\n')).toMatch(/substitution/);
  });
});

describe('validateScenarioDir', () => {
  it('names a missing file', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'x'));
    expect(validateScenarioDir(join(dir, 'x')).join('\n')).toMatch(/scenario\.json/);
  });

  it('names JSON that doesn\'t parse', () => {
    const dir = writeScenario({ extra: { 'steps.json': '{ phases: ' } });
    expect(validateScenarioDir(dir).join('\n')).toMatch(/steps\.json.*JSON/);
  });
});

/** Steps before a reference, so the reference resolves. */
const OPENED = [
  { verb: 'pr.open', name: 'docs', head: 'docs', title: 'Docs' },
  { verb: 'issue.open', name: 'bug', title: 'A bug' },
  { verb: 'run.await', name: 'ci', workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 10 },
];

/** Every verb of the vocabulary, each in a segment it belongs in. */
const EVERY_VERB = {
  phases: [
    {
      kanon: [
        { verb: 'kanon.at', release: 'previous', command: 'init', flags: ['--feature=full'] },
        { verb: 'kanon.init', flags: ['--feature=full', '--review-trigger=labelled', '--no-sensitive-data'] },
        { verb: 'expect.init', status: 'steps-left', exitCode: 0, findings: ['label.create', 'ruleset.create'], absent: ['app.failed'], fields: [{ pointer: '/pin', equals: 'candidate-v0.41.0' }] },
        { verb: 'register.write' },
        { verb: 'pins.move' },
      ],
      act: [
        { verb: 'files.commit', from: 'kanon', message: 'Install Kanon' },
        { verb: 'bootstrap.end', move: 'record' },
        { verb: 'repo.apply' },
        { verb: 'environment.create', name: 'production', tags: 'v*.*.*', reviewer: true },
        { verb: 'ruleset.tags', pattern: 'v*.*.*', bypass: ['releaser'] },
        { verb: 'files.commit', from: 'scenario', dir: 'files/fix', branch: 'docs', message: 'docs: a line', delete: ['docs/old.md'] },
        { verb: 'pr.open', name: 'docs', head: 'docs', title: 'docs: a line', body: 'One line.' },
        { verb: 'pr.label', pr: 'docs', add: ['review:please'] },
        { verb: 'run.await', name: 'ci', workflow: 'ci.yml', event: 'pull_request', pr: 'docs', deadline: 15 },
        { verb: 'expect.run', run: 'ci', conclusion: 'success', jobs: [{ name: 'Lane check', conclusion: 'success' }], deadline: 2 },
        { verb: 'expect.check', pr: 'docs', name: 'Lane check', conclusion: 'success', deadline: 5 },
        { verb: 'expect.artifact', run: 'ci', name: 'agent-run-row', deadline: 2 },
        { verb: 'expect.row', run: 'ci', lane: 'review', ceilingUsd: 30, deadline: 2 },
        { verb: 'pr.merge', pr: 'docs', via: 'front-door', deadline: 20 },
        { verb: 'expect.pr', pr: 'docs', state: 'merged', labels: ['review:please'], labelsAbsent: ['needs:human'], author: 'kanon-e2e-author', marker: 'role:reviewer', markerBy: 'kanon-e2e-judge', deadline: 5 },
        { verb: 'issue.open', name: 'bug', title: 'A bug', labels: ['bug'] },
        { verb: 'issue.label', issue: 'bug', add: ['sev:low'] },
        { verb: 'expect.issue', issue: 'bug', state: 'open', labels: ['bug', 'sev:low'], deadline: 5 },
        { verb: 'workflow.dispatch', workflow: 'apps-check.yml', inputs: { reason: 'scenario' } },
        { verb: 'repo.apply' },
        { verb: 'bootstrap.end', move: 'approval' },
      ],
    },
    {
      kanon: [
        { verb: 'kanon.doctor', to: true },
        { verb: 'expect.doctor', status: 'incomplete', exitCode: 4, unchecked: ['secrets'], absent: ['ruleset.missing'] },
      ],
      act: [
        { verb: 'release.cut', deadline: 30 },
        { verb: 'expect.pr', pr: 'release', state: 'merged', author: 'kanon-e2e-releaser', deadline: 5 },
        { verb: 'deployment.await-approval', environment: 'production', workflow: 'deploy.yml', deadline: 30 },
        { verb: 'issue.await', name: 'deploy-failed', author: 'github-actions', labels: ['bug'], deadline: 20 },
        { verb: 'expect.issue', issue: 'deploy-failed', state: 'open', deadline: 5 },
        { verb: 'expect.api', path: 'repos/{{repository}}/rulesets', pointer: '/0/name', equals: 'Kanon: default branch', deadline: 5 },
      ],
    },
  ],
};
