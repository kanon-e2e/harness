import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateScenarioDir } from '../runner/validate.mjs';

/**
 * The first scenario, the deploy lane's rehearsal (Kanon plan 0012 step E5, harness #26), held to
 * the issue's acceptance criteria as data: plan 0010's D12 rehearsal, repeated on every candidate.
 * Three releases go through Kanon's deploy lane in a fresh repository with staging then
 * production; the first waits for production's reviewer, the second's smoke check fails in
 * staging and files its issue, the third closes it, and doctor reports no `deploy.*` finding.
 */

const DIR = 'scenarios/deploy-rehearsal';
const read = (path) => readFileSync(new URL(`../${DIR}/${path}`, import.meta.url), 'utf8');
const scenario = JSON.parse(read('scenario.json'));
const { phases } = JSON.parse(read('steps.json'));
const steps = phases.flatMap((p, i) => [...p.kanon.map((s) => ({ ...s, phase: i + 1, segment: 'kanon' })), ...p.act.map((s) => ({ ...s, phase: i + 1, segment: 'act' }))]);
const ofVerb = (verb) => steps.filter((s) => s.verb === verb);
const at = (step) => steps.indexOf(step);

/** Every `deploy.*` finding Kanon's doctor reports (cli/doctor.mjs, plan 0010 D4 to D8). */
const DEPLOY_FINDINGS = [
  'deploy.admin-bypass', 'deploy.artifact-retention', 'deploy.branch-policy', 'deploy.caller-mismatch',
  'deploy.ci-push-missing', 'deploy.declaration', 'deploy.declaration-moved', 'deploy.environment-missing',
  'deploy.hook-missing', 'deploy.reference-undeclared', 'deploy.releaser-missing', 'deploy.reviewers-missing',
  'deploy.secret-organization', 'deploy.secret-repository', 'deploy.self-review', 'deploy.subject-custom',
  'deploy.tag-ruleset', 'deploy.trust-unproven',
];

/** The jobs a run of the deploy caller lists for an environment, and for the release. */
const RELEASE_JOBS = ['gate', 'probe', 'build', 'record', 'report'].map((j) => `release / ${j}`);
const envJobs = (env, ...jobs) => jobs.map((j) => `${env} / ${j}`);

describe('the deploy rehearsal is a valid scenario of the deploy family', () => {
  it('validates', () => {
    expect(validateScenarioDir(DIR)).toEqual([]);
  });

  it('scenario.json: family deploy, no model, no Claude, the Releaser, and gate: true (burnt in)', () => {
    expect(scenario).toMatchObject({ id: 'deploy-rehearsal', family: 'deploy', tier: 'none', claude: 'none', gate: true });
    expect(scenario.apps).toContain('releaser');
    // The review lane init installs reads the Reviewer's slug from the App register (K-LAYOUT-6).
    expect(scenario.apps).toContain('judge');
    expect(scenario.deadlineMinutes).toBeLessThanOrEqual(120);
  });

  it('pins Kanon\'s release workflow to the release under test, mapping the Releaser\'s two secrets by name', () => {
    const release = read('start/.github/workflows/release.yml');
    expect(release).toContain('uses: yedeya-labs/kanon/.github/workflows/release.yml@{{release}}');
    expect(release).toContain('RELEASER_APP_ID: ${{ secrets.RELEASER_APP_ID }}');
    expect(release).toContain('RELEASER_APP_PRIVATE_KEY: ${{ secrets.RELEASER_APP_PRIVATE_KEY }}');
    expect(release).not.toMatch(/secrets: inherit/);
    expect(JSON.parse(read('start/.release-please-manifest.json'))).toEqual({ '.': '0.0.0' });
    expect(JSON.parse(read('start/release-please-config.json')).packages['.']).toMatchObject({ 'release-type': 'simple', 'include-v-in-tag': true, 'include-component-in-tag': false });
  });

  it('declares staging then production to kanon init, which writes the caller pinned to the release under test', () => {
    const [init] = ofVerb('kanon.init');
    expect(init.phase).toBe(1);
    expect(init.flags).toContain('--deploy-environments=staging,production');
  });

  it('writes the App register in the kanon segment, before the install is committed, or lane-check fails CI and the gate refuses the release', () => {
    const [register] = ofVerb('register.write');
    expect(register).toMatchObject({ phase: 1, segment: 'kanon' });
    expect(phases[0].kanon.findIndex((s) => s.verb === 'register.write')).toBeGreaterThan(phases[0].kanon.findIndex((s) => s.verb === 'kanon.init'));
  });

  it('fills the three hooks in start/, so init writes no stub over them, and the deploy hook answers the trust probe `refused`', () => {
    for (const hook of ['build', 'deploy', 'smoke']) expect(read(`start/.github/actions/${hook}/action.yml`)).toMatch(/runs:\n {2}using: composite/);
    const deploy = read('start/.github/actions/deploy/action.yml');
    expect(deploy).toContain('kanon-deploy-probe.json');
    expect(deploy).toContain('"refused"');
    expect(read('start/.github/actions/smoke/action.yml')).not.toMatch(/exit 1/);
  });
});

describe('the repository is set up as plan 0010 §4 and §12 ask, before the first release', () => {
  it('creates both environments with the release tags alone as their refs, production with the Owner as its required reviewer', () => {
    expect(ofVerb('environment.create').map(({ name, tags, reviewer }) => ({ name, tags, reviewer }))).toEqual([
      { name: 'staging', tags: 'v*.*.*', reviewer: undefined },
      { name: 'production', tags: 'v*.*.*', reviewer: true },
    ]);
  });

  it('restricts the release tags with a ruleset the Releaser bypasses', () => {
    expect(ofVerb('ruleset.tags')).toEqual([expect.objectContaining({ pattern: 'v*.*.*', bypass: ['releaser'] })]);
  });

  it('runs with no default-branch ruleset, as its README says: repo.apply never sets firstCommit, so init\'s ruleset.first-commit is not applied (#57)', () => {
    const applies = ofVerb('repo.apply');
    expect(applies.length).toBeGreaterThan(0);
    for (const a of applies) expect(a.firstCommit).toBeUndefined();
  });

  it('does all of it before the first release is cut', () => {
    const first = ofVerb('release.cut')[0];
    for (const s of [...ofVerb('environment.create'), ...ofVerb('ruleset.tags'), ...ofVerb('repo.apply')]) expect(at(s)).toBeLessThan(at(first));
  });
});

describe('three releases, each with what it expects', () => {
  const cuts = ofVerb('release.cut');
  const merges = ofVerb('pr.merge');
  const titles = ofVerb('pr.open').map((s) => s.title);

  it('cuts three releases, each from a front-door merge of a conventional commit: feat, then fix, then fix', () => {
    expect(cuts).toHaveLength(3);
    expect(merges.map((s) => s.via)).toEqual(['front-door', 'front-door', 'front-door']);
    expect(titles.map((t) => t.split(':')[0])).toEqual(['feat', 'fix', 'fix']);
  });

  it('the first: the second environment waits for its reviewer, then the run executes the gate, the probe, the build, both environments, and every record and report', () => {
    const [wait] = ofVerb('deployment.await-approval');
    expect(wait).toMatchObject({ environment: 'production', workflow: 'deploy.yml' });
    expect(at(wait)).toBeGreaterThan(at(cuts[0]));
    expect(at(wait)).toBeLessThan(at(cuts[1]));
    const run = ofVerb('expect.run').find((s) => s.run === 'release-1');
    const names = run.jobs.map((j) => j.name);
    expect(names).toEqual([...RELEASE_JOBS, ...envJobs('staging', 'deploy', 'record', 'report'), ...envJobs('production', 'record', 'report')]);
    expect(run.jobs.every((j) => j.conclusion === 'success')).toBe(true);
  });

  it('the first run lists the reference deploy\'s job, as init declares it: the first environment\'s deploy', () => {
    const run = ofVerb('expect.run').find((s) => s.run === 'release-1');
    expect(run.jobs.map((j) => j.name)).toContain('staging / deploy');
  });

  it('waits for production\'s reviewer in a phase of its own, with an act job\'s whole time to see the wait and cancel', () => {
    const [wait] = ofVerb('deployment.await-approval');
    const phase = phases[wait.phase - 1];
    expect(phase.act[0]).toEqual(expect.objectContaining({ verb: 'deployment.await-approval' }));
    expect(phase.act.filter((s) => s.verb === 'release.cut' || s.verb === 'pr.merge')).toEqual([]);
  });

  it('the second: its smoke check fails in staging, and the lane files staging\'s issue', () => {
    expect(read('smoke-fails/.github/actions/smoke/action.yml')).toMatch(/exit 1/);
    const run = ofVerb('expect.run').find((s) => s.run === 'release-2');
    expect(run.conclusion).toBe('failure');
    expect(run.jobs).toContainEqual({ name: 'staging / report', conclusion: 'success' });
    const [found] = ofVerb('issue.await');
    expect(found).toMatchObject({ name: 'staging-failed', author: 'github-actions', labels: ['bug', 'sev:medium'] });
    expect(at(found)).toBeGreaterThan(at(cuts[1]));
    expect(at(found)).toBeLessThan(at(cuts[2]));
    const open = ofVerb('expect.issue').find((s) => s.state === 'open');
    expect(open).toMatchObject({ issue: 'staging-failed', labels: ['bug', 'sev:medium'] });
  });

  it('the second: the deploy job succeeds, since the hook did and the smoke check is continue-on-error, and the verdict job fails the call (Kanon 0.43.0, plan 0013 §7.1)', () => {
    const run = ofVerb('expect.run').find((s) => s.run === 'release-2');
    expect(run.jobs).toContainEqual({ name: 'staging / deploy', conclusion: 'success' });
    expect(run.jobs).toContainEqual({ name: 'staging / verdict', conclusion: 'failure' });
    expect(run.jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name)).toEqual(['staging / verdict']);
    expect(run.jobs.map((j) => j.name)).toEqual([...RELEASE_JOBS.slice(0, 3), ...envJobs('staging', 'deploy', 'verdict', 'record', 'report')]);
  });

  it('the third: its smoke check passes again, and its success closes that issue', () => {
    expect(read('smoke-passes/.github/actions/smoke/action.yml')).toBe(read('start/.github/actions/smoke/action.yml'));
    const closed = ofVerb('expect.issue').find((s) => s.state === 'closed');
    expect(closed.issue).toBe('staging-failed');
    expect(at(closed)).toBeGreaterThan(at(cuts[2]));
  });
});

describe('doctor reports no deploy.* finding once the lane has run', () => {
  const [doctor] = ofVerb('kanon.doctor');
  const [expectation] = ofVerb('expect.doctor');

  it('runs after the first release\'s run, which carries the trust probe\'s line', () => {
    expect(doctor.phase).toBeGreaterThan(ofVerb('deployment.await-approval')[0].phase);
    expect(at(expectation)).toBeGreaterThan(at(doctor));
  });

  it('holds every deploy.* id absent, and expects none present', () => {
    expect([...expectation.absent].sort()).toEqual([...DEPLOY_FINDINGS].sort());
    expect((expectation.findings ?? []).filter((id) => id.startsWith('deploy.'))).toEqual([]);
  });
});
