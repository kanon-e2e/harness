import { describe, expect, it } from 'vitest';
import { RESULT_STEPS, actJob, attested, readJobs } from '../runner/evidence.mjs';
import { readWorkflows } from './helpers/workflows.mjs';
import { stubGh } from './helpers/stubs.mjs';

/**
 * What only an `act` job can write (harness #24, R3): the run's jobs list. Code in a `kanon` job
 * can upload an artifact under any name in the run, a `kanon-e2e-result-<scenario>` reading
 * `pass` among them, but it can't add a step to an `act` job or change how one concluded. So a
 * scenario's result is the one its first `act` job to finalize it names, by the one result step
 * it ran; and a `pass` counts only when that job is the scenario's last `act` job that ran, and
 * concluded `success` (the Owner, 2026-10-19).
 */

const ID = 'deploy-rehearsal';
const step = (name, conclusion) => ({ name, conclusion });
/** An `act` job of `ID`'s, as the jobs list holds it: its result steps, the one `result` names run, the others skipped. */
const act = (phase, { result = null, conclusion = 'success', id = ID, steps } = {}) => ({
  name: actJob(phase, id), conclusion,
  steps: steps ?? [step('Run the act segment', 'success'), ...['pass', 'fail', 'infra'].map((r) => step(RESULT_STEPS[r], r === result ? 'success' : 'skipped'))],
});

describe('the result step an `act` job runs, and the job it runs in', () => {
  it('names the job as GitHub lists a called workflow\'s: `act-<n> (<scenario>) / job / act segment`', () => {
    expect(actJob(2, 'install-build')).toBe('act-2 (install-build) / job / act segment');
  });

  it('e2e-act-job.yml runs one step per result, each only when the job finalized the scenario with it, running nothing but `echo`', () => {
    const job = Object.values(readWorkflows()['e2e-act-job.yml'].jobs)[0];
    const run = job.steps.findIndex((s) => s.id === 'run');
    for (const r of ['pass', 'fail', 'infra']) {
      const i = job.steps.findIndex((s) => s.name === RESULT_STEPS[r]);
      expect(i, r).toBeGreaterThan(run);
      expect(job.steps[i].if, r).toBe(`\${{ steps.run.outputs.finalized == 'true' && steps.run.outputs.result == '${r}' }}`);
      expect(job.steps[i].run, r).toMatch(/^echo "[^"$`\\]*"$/);
      expect(Object.keys(job.steps[i]).sort(), r).toEqual(['if', 'name', 'run']);
    }
  });
});

describe('attested(): a scenario\'s result from the jobs list (#24, R3)', () => {
  it('reads the result the finalizing `act` job\'s step names: pass, fail or infra', () => {
    expect(attested([act(1), act(2), act(3, { result: 'pass' })], ID)).toMatchObject({ result: 'pass', phase: 3 });
    expect(attested([act(1, { result: 'fail' })], ID)).toMatchObject({ result: 'fail', phase: 1 });
    expect(attested([act(1), act(2, { result: 'infra' })], ID)).toMatchObject({ result: 'infra', phase: 2 });
  });

  it('the first `act` job to finalize the scenario names its result: a later one can\'t turn a `fail` into a `pass`', () => {
    expect(attested([act(1, { result: 'fail' }), act(2), act(3, { result: 'pass' })], ID)).toMatchObject({ result: 'fail', phase: 1 });
  });

  it('a `pass` counts only when its job is the scenario\'s last `act` job that ran, and concluded `success`', () => {
    expect(attested([act(1), act(2, { result: 'pass' }), act(3, { conclusion: 'failure' })], ID)).toMatchObject({ result: 'unconfirmed', why: expect.stringMatching(/act-3 ran after act-2/) });
    expect(attested([act(1), act(2, { result: 'pass', conclusion: 'failure' })], ID)).toMatchObject({ result: 'unconfirmed', why: expect.stringMatching(/concluded failure/) });
    expect(attested([act(1, { result: 'pass', conclusion: null })], ID).result).toBe('unconfirmed');
    // A job skipped by its condition didn't run, so it is not the last that ran.
    expect(attested([act(1, { result: 'pass' }), act(2, { conclusion: 'skipped', steps: [] })], ID).result).toBe('pass');
  });

  it('a `fail` or an `infra` counts whatever its job concluded: R3 only holds back a `pass`', () => {
    expect(attested([act(1, { result: 'fail', conclusion: 'failure' }), act(2, { conclusion: 'failure' })], ID).result).toBe('fail');
  });

  it('no evidence at all is no result: no `act` job of the scenario ran, or none finalized it', () => {
    expect(attested([], ID)).toMatchObject({ result: null, why: expect.stringMatching(/no `act` job/) });
    expect(attested([act(1), act(2)], ID)).toMatchObject({ result: null, legacy: false });
    // Another scenario's job, however it reads, is not this one's.
    expect(attested([act(1, { id: 'install-build', result: 'pass' })], ID).result).toBeNull();
    expect(attested([{ ...act(1, { result: 'pass' }), name: `act-1 (${ID}) / mint (the act token)` }], ID).result).toBeNull();
  });

  it('a step whose name is a result\'s but that didn\'t succeed, or two results in one job, confirm nothing', () => {
    expect(attested([act(1, { steps: [step(RESULT_STEPS.pass, 'failure')] })], ID).result).toBeNull();
    expect(attested([act(1, { steps: [step(RESULT_STEPS.pass, 'success'), step(RESULT_STEPS.fail, 'success')] })], ID).result).toBe('unconfirmed');
  });

  it('tells a run from before the result steps existed (`legacy`): its `act` jobs ran, and none lists one', () => {
    expect(attested([act(1, { steps: [step('Run the act segment', 'success')] }), act(2, { steps: [] })], ID)).toMatchObject({ result: null, legacy: true });
    expect(attested([], ID).legacy).toBe(false);
  });
});

describe('readJobs(): the attempt\'s jobs, every page', () => {
  it('reads `actions/runs/<id>/attempts/<n>/jobs`, paginated, and flattens the pages', async () => {
    const g = stubGh({ 'GET repos/kanon-e2e/harness/actions/runs/7/attempts/2/jobs?per_page=100': [{ total_count: 3, jobs: [act(1), act(2)] }, { total_count: 3, jobs: [act(3)] }] });
    expect((await readJobs({ gh: g.gh, repository: 'kanon-e2e/harness' }, '7', '2')).map((j) => j.name)).toEqual([actJob(1, ID), actJob(2, ID), actJob(3, ID)]);
    expect(g.calls[0].args).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
  });
});
