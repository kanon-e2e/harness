import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { validateScenarioDir } from '../runner/validate.mjs';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { REPO, context, inTurn, stubGh } from './helpers/stubs.mjs';

/**
 * The gate refusals (Kanon plan 0012 §6.1, step E12), held to their issue's acceptance criteria as
 * data. Each scenario puts one of the lanes' own admission rules in front of a real event that
 * the rule must refuse, and expects the refusal concretely: which jobs ran, which were skipped,
 * and what was filed. E12's mutation cell ("as E5, per scenario": a copy whose expectation is
 * wrong reads `fail`) is the last block: each scenario's own expectation steps are run on the
 * refused run, on the run an admitted event would make, and as wrong copies of themselves.
 *
 * The plan's second refusal, the Merger refusing a pull request with no verdict, has no scenario:
 * every event the harness can make in a scenario repository is the driver App's, which the
 * Merger's membership gate refuses before it reads any verdict (scenarios/README.md says so).
 */

const ROOT = new URL('../', import.meta.url).pathname;

const SCENARIOS = {
  'refuse-review-label': { family: 'lane', apps: ['judge'], deadlineMinutes: 60 },
  'refuse-deploy-ci-red': { family: 'deploy', apps: ['judge', 'releaser'], deadlineMinutes: 75 },
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

/** A step without the bookkeeping `load` adds. */
const bare = ({ phase, segment, ...step }) => step;

describe.each(Object.entries(SCENARIOS))('%s', (id, { family, apps, deadlineMinutes }) => {
  const s = load(id);

  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it(`scenario.json: family ${family}, no model, no Claude, and gate: false until its burn-in`, () => {
    expect(s.scenario).toEqual({ id, family, tier: 'none', gate: false, apps, claude: 'none', deadlineMinutes });
  });

  it('starts its repository with a README that names the release and the repository', () => {
    const text = s.read('start/README.md');
    expect(text).toContain(`# ${id}`);
    expect(text).toContain('{{release}}');
    expect(text).toContain('{{repository}}');
  });

  it('has a README in the house style, naming plan 0012 step E12, its gate: false and the refusal it holds', () => {
    const readme = s.read('README.md');
    for (const heading of ['What the repository holds', 'The flags', 'The steps', 'What it creates', 'What it costs', 'When it is red']) expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    expect(readme).toContain('Kanon\'s plan 0012 step E12');
    expect(readme).toContain('`gate: false`');
    const table = readme.slice(readme.indexOf('## The steps'), readme.indexOf('## What it creates'));
    expect(table).toContain('**The refusal');
  });

  it('dispatches no workflow besides apps-check, and runs no model', () => {
    expect(s.ofVerb('workflow.dispatch').map((d) => d.workflow).filter((w) => w !== 'apps-check.yml')).toEqual([]);
    expect(s.scenario.claude).toBe('none');
  });
});

describe('refuse-review-label: a label applied by an identity outside the register starts nothing', () => {
  const s = load('refuse-review-label');
  const install = load('install-review');
  const [phase1, phase2] = s.phases;

  it('phase 1 is install-review\'s clean install, step for step, kanon and act', () => {
    expect(phase1).toEqual(install.phases[0]);
    expect(s.phases).toHaveLength(2);
    expect(phase2.kanon).toEqual([]);
  });

  it('the label is applied in an act segment, so by the driver App, which no register row names', () => {
    const [label] = s.ofVerb('pr.label');
    expect(label).toMatchObject({ segment: 'act', phase: 2, pr: 'note', add: ['review:please'] });
    // register.write writes rows only for scenario.json's apps, from runner/test-apps.json: the
    // driver is not one of them, so the register can't name it.
    const testApps = JSON.parse(readFileSync(join(ROOT, 'runner/test-apps.json'), 'utf8')).apps;
    expect(Object.keys(testApps)).not.toContain('driver');
    expect(s.scenario.apps.map((a) => testApps[a])).toEqual(['kanon-e2e-judge']);
  });

  it('labels a pull request of its own, on a branch, opened as the driver: no push reaches the default branch after the ruleset', () => {
    const [commit] = phase2.act.filter((x) => x.verb === 'files.commit');
    const [open] = s.ofVerb('pr.open');
    expect(commit).toMatchObject({ from: 'scenario', dir: 'change', branch: 'docs-note' });
    expect(open).toMatchObject({ name: 'note', head: 'docs-note' });
    expect(files(join(s.dir, 'change'))).toEqual(['docs/note.md']);
  });

  it('waits until both runs exist, the opened event\'s and the label\'s, before it keeps the newest', () => {
    const verbs = phase2.act.map((x) => x.verb);
    expect(verbs).toEqual(['files.commit', 'pr.open', 'pr.label', 'expect.api', 'run.await', 'expect.run', 'expect.pr']);
    const [count] = s.ofVerb('expect.api');
    expect(count).toMatchObject({ path: 'repos/{{repository}}/actions/workflows/agent-review.yml/runs?event=pull_request_target&branch=docs-note', pointer: '/total_count', equals: 2 });
    const [awaited] = phase2.act.filter((x) => x.verb === 'run.await');
    expect(awaited).toMatchObject({ name: 'review-label', workflow: 'agent-review.yml', event: 'pull_request_target', pr: 'note' });
  });

  it('expects the refusal: the filter ran and succeeded, and the review and the notice were skipped', () => {
    const [e] = phase2.act.filter((x) => x.verb === 'expect.run');
    expect(e).toMatchObject({ run: 'review-label', conclusion: 'success' });
    expect(e.jobs).toEqual([
      { name: 'review / filter', conclusion: 'success' },
      { name: 'review / notify-unlabeled', conclusion: 'skipped' },
      { name: 'review / review', conclusion: 'skipped' },
    ]);
    expect(s.ofVerb('expect.pr')).toEqual([expect.objectContaining({ pr: 'note', state: 'open', labels: ['review:please'] })]);
  });
});

describe('refuse-deploy-ci-red: plan 0010\'s deploy gate refuses a release whose CI is red', () => {
  const s = load('refuse-deploy-ci-red');
  const rehearsal = load('deploy-rehearsal');
  const ci = parse(s.read('start/.github/workflows/ci.yml'));

  it('installs as the rehearsal does: the same init flags and register, and the same setup before any release', () => {
    expect(s.phases[0].kanon).toEqual(rehearsal.phases[0].kanon);
    const setup = rehearsal.phases[0].act.slice(0, 5);
    expect(setup.map((x) => x.verb)).toEqual(['files.commit', 'repo.apply', 'environment.create', 'environment.create', 'ruleset.tags']);
    expect(s.phases[0].act.slice(0, 5)).toEqual(setup);
  });

  it('keeps the rehearsal\'s start tree, and adds only the project\'s CI, its tests and what they test', () => {
    const mine = files(join(s.dir, 'start'));
    const theirs = files(join(rehearsal.dir, 'start'));
    expect(mine.filter((f) => !theirs.includes(f))).toEqual(['.github/workflows/ci.yml', 'src/greeting.txt', 'test.sh']);
    expect(theirs.filter((f) => !mine.includes(f))).toEqual([]);
    for (const f of ['.github/workflows/release.yml', 'release-please-config.json', '.release-please-manifest.json', 'version.txt']) expect(s.read(`start/${f}`)).toBe(rehearsal.read(`start/${f}`));
  });

  it('ci.yml is CI on every push to the default branch, with Kanon\'s Lane check as init writes it, pinned to the release, beside the project\'s tests', () => {
    expect(ci.name).toBe('CI');
    expect(ci.on.push).toEqual({ branches: ['main'] });
    expect(Object.keys(ci.on)).toEqual(['pull_request', 'merge_group', 'push']);
    expect(ci.jobs.lanes.name).toBe('Lane check');
    expect(ci.jobs.lanes.steps).toEqual([{ uses: 'actions/checkout@v7' }, { uses: 'yedeya-labs/kanon/actions/lane-check@{{release}}' }]);
    expect(ci.jobs.tests.name).toBe('Tests');
    expect(ci.jobs.tests.steps.at(-1).run).toBe('sh test.sh');
    expect(s.read('start/.github/workflows/ci.yml')).not.toMatch(/secrets\.|secrets: inherit/);
  });

  it('the tests pass on the start tree and fail on the regression, which changes only what they test', () => {
    const sh = (greeting) => {
      try {
        execFileSync('sh', ['-c', `cd "$(mktemp -d)" && mkdir src && cp "$0" test.sh && printf '%s\\n' "$1" > src/greeting.txt && sh test.sh`, join(s.dir, 'start/test.sh'), greeting], { stdio: 'pipe' });
        return 0;
      } catch (e) {
        return e.status;
      }
    };
    expect(s.read('start/src/greeting.txt')).toBe('hello\n');
    expect(files(join(s.dir, 'regression'))).toEqual(['src/greeting.txt']);
    expect(sh(s.read('start/src/greeting.txt').trim())).toBe(0);
    expect(sh(s.read('regression/src/greeting.txt').trim())).toBe(1);
  });

  it('holds CI green before the change, so the red is the change\'s', () => {
    const e = s.phases[0].act.find((x) => x.verb === 'expect.run');
    expect(e).toMatchObject({ run: 'ci-install', conclusion: 'success', jobs: [{ name: 'Lane check', conclusion: 'success' }, { name: 'Tests', conclusion: 'success' }] });
  });

  it('merges the regression through the front door, then cuts one release from it, in a phase of its own', () => {
    expect(s.phases[1].kanon).toEqual([]);
    expect(s.phases[1].act.map((x) => x.verb)).toEqual(['files.commit', 'pr.open', 'pr.merge', 'release.cut']);
    expect(s.phases[1].act[0]).toMatchObject({ from: 'scenario', dir: 'regression', branch: 'regression' });
    expect(s.phases[1].act[2]).toMatchObject({ pr: 'regression', via: 'front-door' });
    expect(s.phases[1].act[1].title.split(':')[0]).toBe('feat');
  });

  it('expects the release\'s CI red, by the project\'s tests alone', () => {
    const e = s.phases[2].act.find((x) => x.verb === 'expect.run' && x.run === 'ci-release');
    expect(e).toMatchObject({ conclusion: 'failure', jobs: [{ name: 'Lane check', conclusion: 'success' }, { name: 'Tests', conclusion: 'failure' }] });
  });

  it('expects the gate\'s refusal: the gate failed, nothing built or deployed, the row and the issue written', () => {
    const e = s.phases[2].act.find((x) => x.verb === 'expect.run' && x.run === 'release');
    expect(e.conclusion).toBe('failure');
    expect(e.jobs).toEqual([
      { name: 'release / gate', conclusion: 'failure' },
      { name: 'release / probe', conclusion: 'skipped' },
      { name: 'release / build', conclusion: 'skipped' },
      { name: 'release / record', conclusion: 'success' },
      { name: 'release / report', conclusion: 'success' },
      { name: 'staging', conclusion: 'skipped' },
      { name: 'production', conclusion: 'skipped' },
    ]);
    expect(s.ofVerb('deployment.await-approval')).toEqual([]);
    const [found] = s.ofVerb('issue.await');
    expect(found).toMatchObject({ author: 'github-actions', labels: ['bug', 'sev:medium'] });
    expect(s.ofVerb('expect.issue')).toEqual([expect.objectContaining({ issue: found.name, state: 'open', author: 'github-actions', labels: ['bug', 'sev:medium'] })]);
  });

  it('fits each act segment\'s waits in an act job\'s 30 minutes', () => {
    for (const p of s.phases) expect(p.act.reduce((n, x) => n + (x.deadline ?? 0), 0)).toBeLessThanOrEqual(30);
  });
});

describe('E12\'s mutation: a copy of a scenario whose expectation is wrong reads fail', () => {
  const fails = { name: 'Fail' };
  const RUN = 7;
  /** A kept run, as the API answers for it and its jobs. */
  const runOf = (conclusion, jobs) => stubGh({
    [`GET repos/${REPO}/actions/runs/${RUN}`]: { id: RUN, status: 'completed', conclusion },
    [`GET repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100`]: { jobs: jobs.map(([name, c], i) => ({ id: 100 + i, name, conclusion: c })) },
  }).gh;
  const hold = (step, gh) => VOCABULARY['expect.run'].run(bare(step), context({ gh, state: { runs: { [step.run]: RUN } } }));

  describe('refuse-review-label', () => {
    const s = load('refuse-review-label');
    const step = s.phases[1].act.find((x) => x.verb === 'expect.run');
    /** The label's run when the gate refuses the driver. */
    const REFUSED = ['success', [['review / filter', 'success'], ['review / notify-unlabeled', 'skipped'], ['review / review', 'skipped']]];

    it('passes on the refused run', async () => {
      await hold(step, runOf(...REFUSED));
    });

    it('fails on the run a member\'s label makes: the review job runs', async () => {
      await expect(hold(step, runOf('success', [['review / filter', 'success'], ['review / notify-unlabeled', 'skipped'], ['review / review', 'success']]))).rejects.toMatchObject(fails);
      // Admitted here, with no Claude token in the repository, the review fails, and so does the run.
      await expect(hold(step, runOf('failure', [['review / filter', 'success'], ['review / notify-unlabeled', 'skipped'], ['review / review', 'failure']]))).rejects.toMatchObject(fails);
    });

    it('fails when the filter declined the event before the gate, or the gate failed instead of refusing', async () => {
      await expect(hold(step, runOf('skipped', [['review / filter', 'skipped'], ['review / notify-unlabeled', 'skipped'], ['review / review', 'skipped']]))).rejects.toMatchObject(fails);
      await expect(hold(step, runOf('failure', [['review / filter', 'failure'], ['review / notify-unlabeled', 'skipped'], ['review / review', 'skipped']]))).rejects.toMatchObject(fails);
    });

    it('fails a copy that expects the label to start a review', async () => {
      const wrong = { ...step, jobs: step.jobs.map((j) => (j.name === 'review / review' ? { ...j, conclusion: 'success' } : j)) };
      await expect(hold(wrong, runOf(...REFUSED))).rejects.toMatchObject(fails);
    });

    it('keeps the label\'s run, never the opened event\'s, once the count says both exist', async () => {
      const [count] = s.ofVerb('expect.api');
      const awaited = s.phases[1].act.find((x) => x.verb === 'run.await');
      const opened = { id: 41, run_number: 1, status: 'completed', conclusion: 'skipped' };
      const labelled = { id: 42, run_number: 2, status: 'in_progress' };
      const listing = `GET repos/${REPO}/actions/workflows/agent-review.yml/runs?event=pull_request_target&branch=docs-note`;
      const byHead = `GET repos/${REPO}/actions/workflows/agent-review.yml/runs?event=pull_request_target&head_sha=abc&per_page=20`;
      const g = stubGh({
        [listing]: inTurn({ total_count: 1, workflow_runs: [opened] }, { total_count: 2, workflow_runs: [labelled, opened] }),
        [`GET repos/${REPO}/pulls/4`]: { head: { sha: 'abc' } },
        [byHead]: inTurn({ workflow_runs: [opened, labelled] }, { workflow_runs: [opened, { ...labelled, status: 'completed', conclusion: 'success' }] }),
      });
      const ctx = context({ gh: g.gh, state: { prs: { note: 4 } } });
      await VOCABULARY['expect.api'].run(bare(count), ctx);
      await VOCABULARY['run.await'].run(bare(awaited), ctx);
      expect(ctx.state.runs['review-label']).toBe(42);
    });

    it('fails the count while only the opened event\'s run exists', async () => {
      const [count] = s.ofVerb('expect.api');
      const g = stubGh({ [`GET repos/${REPO}/actions/workflows/agent-review.yml/runs?event=pull_request_target&branch=docs-note`]: { total_count: 1, workflow_runs: [] } });
      await expect(VOCABULARY['expect.api'].run(bare(count), context({ gh: g.gh }))).rejects.toMatchObject(fails);
    });
  });

  describe('refuse-deploy-ci-red', () => {
    const s = load('refuse-deploy-ci-red');
    const release = s.phases[2].act.find((x) => x.verb === 'expect.run' && x.run === 'release');
    const ciRelease = s.phases[2].act.find((x) => x.verb === 'expect.run' && x.run === 'ci-release');
    /** The deploy run the gate stops. */
    const REFUSED = ['failure', [
      ['release / gate', 'failure'], ['release / probe', 'skipped'], ['release / build', 'skipped'],
      ['release / record', 'success'], ['release / report', 'success'], ['staging', 'skipped'], ['production', 'skipped'],
    ]];
    /** The deploy run a green commit gets, as the rehearsal's first release: everything up to production's wait. */
    const ADMITTED = ['cancelled', [
      ['release / gate', 'success'], ['release / probe', 'success'], ['release / build', 'success'],
      ['release / record', 'success'], ['release / report', 'success'],
      ['staging / deploy', 'success'], ['staging / record', 'success'], ['staging / report', 'success'], ['production / deploy', 'cancelled'],
    ]];

    it('passes on the refused run', async () => {
      await hold(release, runOf(...REFUSED));
    });

    it('fails on the run the gate lets through: the rehearsal\'s first release', async () => {
      await expect(hold(release, runOf(...ADMITTED))).rejects.toMatchObject(fails);
    });

    it('fails when the gate passed and a later job stopped the run, or something ran after a failed gate', async () => {
      const probeFailed = ['failure', REFUSED[1].map(([n, c]) => [n, n === 'release / gate' ? 'success' : n === 'release / probe' ? 'failure' : c])];
      await expect(hold(release, runOf(...probeFailed))).rejects.toMatchObject(fails);
      const built = ['failure', REFUSED[1].map(([n, c]) => [n, n === 'release / build' ? 'success' : c])];
      await expect(hold(release, runOf(...built))).rejects.toMatchObject(fails);
    });

    it('fails a copy that expects the gate to pass', async () => {
      const wrong = { ...release, jobs: release.jobs.map((j) => (j.name === 'release / gate' ? { ...j, conclusion: 'success' } : j)) };
      await expect(hold(wrong, runOf(...REFUSED))).rejects.toMatchObject(fails);
    });

    it('the release\'s CI expectation fails when CI is green, so a green release can\'t pass for a red one', async () => {
      await hold(ciRelease, runOf('failure', [['Lane check', 'success'], ['Tests', 'failure']]));
      await expect(hold(ciRelease, runOf('success', [['Lane check', 'success'], ['Tests', 'success']]))).rejects.toMatchObject(fails);
    });
  });
});

describe('the docs', () => {
  it('scenarios/README.md lists the refusal family\'s scenarios', () => {
    const text = readFileSync(join(ROOT, 'scenarios/README.md'), 'utf8');
    for (const id of Object.keys(SCENARIOS)) expect(text).toContain(`[\`${id}/\`](${id}/README.md)`);
  });

  it('the Merger\'s refusal, left out, is explained where the family is listed', () => {
    const text = readFileSync(join(ROOT, 'scenarios/README.md'), 'utf8');
    expect(text).toMatch(/Merger/);
  });
});
