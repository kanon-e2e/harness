import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushRuns } from '../runner/lib/push.mjs';
import { classify } from '../runner/lib/retry.mjs';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { REPO, RELEASE, context, fail, inTurn, stubGh } from './helpers/stubs.mjs';

/**
 * The verbs that only read, in either kind of segment (Kanon plan 0012 §4.2, §4.3): `run.await`
 * and the expectations. Each reads a field, a finding id or a known marker, never prose; those
 * on the GitHub API poll with a deadline (§10), and a false one fails as `Fail`, never retried.
 */

const run = (verb, step, ctx) => VOCABULARY[verb].run({ verb, ...step }, ctx);
const failsWith = (re) => ({ name: 'Fail', message: expect.stringMatching(re) });

/** Doctor's document as probe 19 measured it on the `kanon` job's read-only token. */
const PROBE_19 = {
  schema: 'kanon-doctor/v1', kanon: 'v0.41.0', status: 'incomplete', exitCode: 4,
  releases: { pinned: RELEASE }, findings: [], waived: [],
  unchecked: [{ check: 'secrets', subject: 'kanon-e2e/harness', reason: 'the token can\'t list the repository\'s secrets' }],
};
const doctor = (document, exit = document.exitCode) => ({ documents: { doctor: { release: RELEASE, exit, document } } });
const INIT = {
  schema: 'kanon-init/v1', kanon: 'v0.41.0', pin: RELEASE, status: 'steps-left', exitCode: 0,
  findings: [{ id: 'label.create', message: 'Some labels are missing.' }, { id: 'ruleset.create', message: 'm' }],
};
const init = (document = INIT, exit = document.exitCode) => ({ documents: { init: { release: RELEASE, exit, document } } });

describe('expect.doctor', () => {
  it('passes probe 19\'s document with exactly `secrets` allowed unchecked and exit 4', async () => {
    await run('expect.doctor', { status: 'incomplete', exitCode: 4, unchecked: ['secrets'] }, context({ state: doctor(PROBE_19) }));
  });

  it('fails the same document when `secrets` isn\'t listed as allowed, so "incomplete" can\'t pass for "healthy"', async () => {
    await expect(run('expect.doctor', { exitCode: 4 }, context({ state: doctor(PROBE_19) }))).rejects.toMatchObject(failsWith(/unchecked.*`secrets`/));
    await expect(run('expect.doctor', {}, context({ state: doctor(PROBE_19) }))).rejects.toMatchObject(failsWith(/`secrets`/));
  });

  it('fails on any other unchecked check, with `secrets` allowed', async () => {
    const more = { ...PROBE_19, unchecked: [...PROBE_19.unchecked, { check: 'notify-secrets', subject: 's', reason: 'r' }] };
    await expect(run('expect.doctor', { status: 'incomplete', exitCode: 4, unchecked: ['secrets'] }, context({ state: doctor(more) }))).rejects.toMatchObject(failsWith(/`notify-secrets`/));
  });

  it('holds the status, the exit code (the process\'s and the document\'s), and finding ids present and absent', async () => {
    const doc = { ...PROBE_19, status: 'findings', exitCode: 1, unchecked: [], findings: [{ id: 'ruleset.missing', message: 'x' }] };
    await run('expect.doctor', { status: 'findings', exitCode: 1, findings: ['ruleset.missing'], absent: ['label.missing'] }, context({ state: doctor(doc) }));
    for (const [step, re] of [
      [{ status: 'healthy' }, /status.*healthy.*findings/],
      [{ exitCode: 0 }, /exit code/],
      [{ findings: ['label.missing'] }, /`label\.missing`/],
      [{ absent: ['ruleset.missing'] }, /`ruleset\.missing`/],
    ]) await expect(run('expect.doctor', step, context({ state: doctor(doc) }))).rejects.toMatchObject(failsWith(re));
    await expect(run('expect.doctor', { exitCode: 1 }, context({ state: doctor(doc, 0) }))).rejects.toMatchObject(failsWith(/exit code/));
  });

  it('holds the blocking findings to exactly the `blocking` ids, by each finding\'s `id` and `blocking` fields (E12)', async () => {
    const f = (id, blocking) => ({ id, blocking, message: 'prose' });
    const doc = { ...PROBE_19, status: 'findings', exitCode: 1, findings: [f('pin.candidate', false), f('ruleset.rule-missing', true), f('ruleset.rule-missing', true)] };
    await run('expect.doctor', { unchecked: ['secrets'], blocking: ['ruleset.rule-missing'] }, context({ state: doctor(doc) }));
    for (const [findings, re] of [
      [[...doc.findings, f('caller.grant-missing', true)], /`caller\.grant-missing` blocks/],
      [[f('ruleset.rule-missing', false)], /`ruleset\.rule-missing`: expected blocking, reported as not blocking/],
      [[f('pin.candidate', false)], /`ruleset\.rule-missing`: expected blocking, not reported/],
    ]) await expect(run('expect.doctor', { unchecked: ['secrets'], blocking: ['ruleset.rule-missing'] }, context({ state: doctor({ ...doc, findings }) }))).rejects.toMatchObject(failsWith(re));
  });

  it('`blocking: []` holds a document to no blocking finding, whatever blocks nothing', async () => {
    const doc = { ...PROBE_19, findings: [{ id: 'pin.candidate', blocking: false, message: 'm' }] };
    await run('expect.doctor', { unchecked: ['secrets'], blocking: [] }, context({ state: doctor(doc) }));
    const blocked = { ...doc, findings: [...doc.findings, { id: 'ruleset.missing', blocking: true, message: 'm' }] };
    await expect(run('expect.doctor', { unchecked: ['secrets'], blocking: [] }, context({ state: doctor(blocked) }))).rejects.toMatchObject(failsWith(/`ruleset\.missing` blocks/));
  });

  it('holds a field at a pointer', async () => {
    await run('expect.doctor', { unchecked: ['secrets'], fields: [{ pointer: '/releases/pinned', equals: RELEASE }] }, context({ state: doctor(PROBE_19) }));
    await expect(run('expect.doctor', { unchecked: ['secrets'], fields: [{ pointer: '/releases/pinned', equals: 'v0.40.0' }] }, context({ state: doctor(PROBE_19) }))).rejects.toMatchObject(failsWith(/\/releases\/pinned/));
  });

  it('refuses without a kept document', async () => {
    await expect(run('expect.doctor', {}, context())).rejects.toThrow(/no kept `kanon doctor` document/);
  });

  it('fills {{release}} in a `fields` entry\'s equals with the release under test before comparing', async () => {
    const doc = { ...PROBE_19, releases: { pins: [RELEASE], pinned: RELEASE } };
    const fields = [{ pointer: '/releases/pins', equals: ['{{release}}'] }, { pointer: '/releases/pinned', equals: '{{release}}' }];
    await run('expect.doctor', { status: 'incomplete', exitCode: 4, unchecked: ['secrets'], fields }, context({ state: doctor(doc) }));
  });

  it('fails when {{release}} is expected and the document pins another release, or a second one beside it', async () => {
    const fields = [{ pointer: '/releases/pins', equals: ['{{release}}'] }, { pointer: '/releases/pinned', equals: '{{release}}' }];
    const other = { ...PROBE_19, releases: { pins: ['v0.40.0'], pinned: 'v0.40.0' } };
    await expect(run('expect.doctor', { unchecked: ['secrets'], fields }, context({ state: doctor(other) })))
      .rejects.toMatchObject(failsWith(new RegExp(`/releases/pins.*${RELEASE}.*v0\\.40\\.0.*/releases/pinned`, 's')));
    const two = { ...PROBE_19, releases: { pins: ['v0.40.0', RELEASE], pinned: RELEASE } };
    await expect(run('expect.doctor', { unchecked: ['secrets'], fields }, context({ state: doctor(two) }))).rejects.toMatchObject(failsWith(/\/releases\/pins/));
  });
});

describe('expect.init', () => {
  it('holds the kept document to a status, an exit code and finding ids present and absent', async () => {
    await run('expect.init', { status: 'steps-left', exitCode: 0, findings: ['label.create'], absent: ['app.failed'], fields: [{ pointer: '/pin', equals: RELEASE }] }, context({ state: init() }));
    await expect(run('expect.init', { status: 'complete', findings: ['app.failed'] }, context({ state: init() }))).rejects.toMatchObject(failsWith(/status.*app\.failed/s));
  });

  it('fills {{release}} in a `fields` entry\'s equals: the document pinning the release under test passes, another fails', async () => {
    await run('expect.init', { status: 'steps-left', fields: [{ pointer: '/pin', equals: '{{release}}' }] }, context({ state: init() }));
    await expect(run('expect.init', { fields: [{ pointer: '/pin', equals: '{{release}}' }] }, context({ state: init({ ...INIT, pin: 'v0.41.0' }) })))
      .rejects.toMatchObject(failsWith(new RegExp(`/pin.*${RELEASE}.*v0\\.41\\.0`)));
  });

  it('never reads a finding\'s message: only its id', async () => {
    const reworded = { ...INIT, findings: INIT.findings.map((f) => ({ ...f, message: 'Reworded entirely.' })) };
    await run('expect.init', { findings: ['label.create', 'ruleset.create'] }, context({ state: init(reworded) }));
  });
});

describe('run.await', () => {
  const RUNS = `GET repos/${REPO}/actions/workflows/ci.yml/runs?event=push&head_sha=abc&per_page=20`;

  it('waits for the workflow\'s run on the event and commit to complete, polling, and keeps its id', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } },
      [RUNS]: inTurn({ workflow_runs: [] }, { workflow_runs: [{ id: 5, run_number: 1, status: 'in_progress' }] }, { workflow_runs: [{ id: 5, run_number: 1, status: 'completed', conclusion: 'failure' }] }),
    });
    const ctx = context({ gh: g.gh });
    await run('run.await', { name: 'ci', workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 10 }, ctx);
    expect(ctx.state.runs).toEqual({ ci: 5 });
    expect(ctx.clock.sleeps).toEqual([2000, 4000]);
  });

  it('reads a pull request\'s head, and names the run for its workflow by default', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/pulls/5`]: { head: { sha: 'def' } },
      [`GET repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=def&per_page=20`]: { workflow_runs: [{ id: 8, run_number: 2, status: 'completed' }, { id: 6, run_number: 1, status: 'completed' }] },
    });
    const ctx = context({ gh: g.gh, state: { prs: { docs: 5 } } });
    await run('run.await', { workflow: 'ci.yml', event: 'pull_request', pr: 'docs', deadline: 10 }, ctx);
    expect(ctx.state.runs).toEqual({ ci: 8 });
  });

  it('with `actor`, keeps the run that App started, not a newer one another App started on the same head (harness #104)', async () => {
    const LABEL = `GET repos/${REPO}/actions/workflows/agent-review.yml/runs?event=pull_request_target&head_sha=def&per_page=20`;
    const by = (login, run) => ({ ...run, triggering_actor: { login }, actor: { login: 'someone-else' } });
    const opened = by('kanon-e2e-driver[bot]', { id: 40, run_number: 1, status: 'completed', conclusion: 'skipped' });
    const review = by('kanon-e2e-author[bot]', { id: 41, run_number: 2, status: 'in_progress' });
    // The Reviewer labels the pull request mid-review: each label starts a run its filter skips in seconds.
    const sev = by('kanon-e2e-judge[bot]', { id: 42, run_number: 3, status: 'completed', conclusion: 'skipped' });
    const agent = by('kanon-e2e-judge[bot]', { id: 43, run_number: 4, status: 'completed', conclusion: 'skipped' });
    const g = stubGh({
      [`GET repos/${REPO}/pulls/5`]: { head: { sha: 'def' } },
      [LABEL]: inTurn({ workflow_runs: [opened, review, sev] }, { workflow_runs: [agent, sev, { ...review, status: 'completed', conclusion: 'success' }, opened] }),
    });
    const ctx = context({ gh: g.gh, state: { prs: { note: 5 } } });
    await run('run.await', { name: 'review', workflow: 'agent-review.yml', event: 'pull_request_target', pr: 'note', actor: 'author', deadline: 25 }, ctx);
    expect(ctx.state.runs).toEqual({ review: 41 });
    // With no `actor`, the newest of all, as before.
    const g2 = stubGh({ [`GET repos/${REPO}/pulls/5`]: { head: { sha: 'def' } }, [LABEL]: { workflow_runs: [opened, { ...review, status: 'completed' }, agent] } });
    const plain = context({ gh: g2.gh, state: { prs: { note: 5 } } });
    await run('run.await', { name: 'review', workflow: 'agent-review.yml', event: 'pull_request_target', pr: 'note', deadline: 5 }, plain);
    expect(plain.state.runs).toEqual({ review: 43 });
  });

  it('with `actor`, a run started only by others is not one: it waits, and says who started them; `actor` takes only a test App', async () => {
    const LABEL = `GET repos/${REPO}/actions/workflows/agent-review.yml/runs?event=pull_request_target&head_sha=def&per_page=20`;
    const g = stubGh({ [`GET repos/${REPO}/pulls/5`]: { head: { sha: 'def' } }, [LABEL]: { workflow_runs: [{ id: 9, run_number: 1, status: 'completed', triggering_actor: { login: 'kanon-e2e-driver[bot]' } }] } });
    await expect(run('run.await', { workflow: 'agent-review.yml', event: 'pull_request_target', pr: 'note', actor: 'author', deadline: 1 }, context({ gh: g.gh, state: { prs: { note: 5 } } })))
      .rejects.toMatchObject(failsWith(/started by kanon-e2e-author\[bot\] yet; 1 started by others: kanon-e2e-driver\[bot\]/));
    expect(VOCABULARY['run.await'].args.actor.enum).toEqual(['author', 'judge', 'releaser']);
  });

  it('waits through a 404 for a workflow a later commit adds, until its run completes (#19)', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } },
      [RUNS]: inTurn(fail('gh: Not Found (HTTP 404)'), { workflow_runs: [{ id: 5, run_number: 1, status: 'completed' }] }),
    });
    const ctx = context({ gh: g.gh });
    await run('run.await', { name: 'ci', workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 10 }, ctx);
    expect(ctx.state.runs).toEqual({ ci: 5 });
    await expect(run('run.await', { workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 1 }, context({ gh: stubGh({ [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } }, [RUNS]: fail('gh: Not Found (HTTP 404)') }).gh })))
      .rejects.toMatchObject(failsWith(/deadline.*ci\.yml.*HTTP 404/));
  });

  const PUSH_RUNS = `GET repos/${REPO}/actions/runs?event=push&head_sha=abc&per_page=1`;

  it('fails when the deadline passes, with a push run of another workflow on the commit (#115)', async () => {
    const g = stubGh({ [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } }, [RUNS]: { workflow_runs: [] }, [PUSH_RUNS]: { total_count: 1, workflow_runs: [{ id: 3 }] } });
    const e = await run('run.await', { workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 1 }, context({ gh: g.gh })).catch((x) => x);
    expect(e).toMatchObject(failsWith(/deadline.*no run of ci\.yml on push for abc yet$/));
    expect(classify(e)).toBe('fail');
  });

  const TREE = `GET repos/${REPO}/contents/.github/workflows/ci.yml?ref=abc`;
  /** A contents answer, as GitHub sends a file: its text in base64. */
  const file = (text) => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
  /** Kanon's own `ci.yml`, as `kanon init` writes it. */
  const CI = '# The project\'s CI\nname: CI\n\non:\n  pull_request:\n  merge_group:\n  push:\n    branches: ["main"]\n\npermissions:\n  contents: read\n';
  const dropped = (tree, extra = {}) => stubGh({ [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } }, [RUNS]: { workflow_runs: [] }, [PUSH_RUNS]: { total_count: 0, workflow_runs: [] }, [TREE]: tree, ...extra });

  it('reads `infra` when the commit\'s tree runs the workflow on that push and GitHub delivered no push run of any kind (#115, #126)', async () => {
    const g = dropped(file(CI));
    const e = await run('run.await', { workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 1 }, context({ gh: g.gh })).catch((x) => x);
    expect(classify(e)).toBe('infra');
    expect(e.message).toMatch(/deadline.*no run of ci\.yml.*no push run was delivered for abc/);
    // The tree first (the Owner's decision of 2026-10-25), then the push runs.
    const keys = g.calls.map((c) => c.key);
    expect(keys.indexOf(TREE)).toBeGreaterThan(-1);
    expect(keys.indexOf(TREE)).toBeLessThan(keys.indexOf(PUSH_RUNS));
  });

  it('reads `fail`, a Kanon finding, when the commit\'s tree has no such workflow, though no push run was delivered (#126)', async () => {
    const g = dropped(fail('gh: Not Found (HTTP 404)'));
    const e = await run('run.await', { workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 1 }, context({ gh: g.gh })).catch((x) => x);
    expect(classify(e)).toBe('fail');
    expect(e).toMatchObject(failsWith(/deadline.*no run of ci\.yml.*abc's tree has no \.github\/workflows\/ci\.yml/));
  });

  it('reads `fail` when the workflow in the tree runs on no push to the branch: no trigger, or a branch filter that leaves it out (#126)', async () => {
    for (const [text, re] of [
      ['on:\n  pull_request:\n  merge_group:\n', /ci\.yml in abc's tree runs on no push to main/],
      ['on:\n  push:\n    branches: [release]\n', /runs on no push to main/],
      ['on:\n  push:\n    tags: [\'v*\']\n', /runs on no push to main/],
    ]) {
      const e = await run('run.await', { workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 1 }, context({ gh: dropped(file(text)).gh })).catch((x) => x);
      expect(classify(e)).toBe('fail');
      expect(e).toMatchObject(failsWith(re));
    }
  });

  it('stays `fail` when the tree can\'t be read, or it can\'t tell whether the workflow would run (#126)', async () => {
    for (const tree of [fail('HTTP 502: Bad Gateway'), file('on:\n  push:\n    paths: [src/**]\n')]) {
      const e = await run('run.await', { workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 1 }, context({ gh: dropped(tree).gh })).catch((x) => x);
      expect(classify(e)).toBe('fail');
    }
  });

  it('reads the branch of a pull request\'s head for a `push` on `pr` (#126)', async () => {
    const PR_PUSH = `GET repos/${REPO}/actions/workflows/ci.yml/runs?event=push&head_sha=abc&per_page=20`;
    const routes = (branches) => stubGh({ [`GET repos/${REPO}/pulls/5`]: { head: { sha: 'abc', ref: 'feat/x' } }, [PR_PUSH]: { workflow_runs: [] }, [PUSH_RUNS]: { total_count: 0 }, [TREE]: file(`on:\n  push:\n    branches: [${branches}]\n`) });
    const at = (branches) => run('run.await', { workflow: 'ci.yml', event: 'push', pr: 'docs', deadline: 1 }, context({ gh: routes(branches).gh, state: { prs: { docs: 5 } } })).catch((x) => x);
    expect(classify(await at("'feat/**'"))).toBe('infra');
    expect(await at('main')).toMatchObject(failsWith(/runs on no push to feat\/x/));
  });

  it('asks for push runs only on a `push` event: another event\'s deadline stays `fail`', async () => {
    const PR_RUNS = `GET repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=def&per_page=20`;
    const g = stubGh({ [`GET repos/${REPO}/pulls/5`]: { head: { sha: 'def' } }, [PR_RUNS]: { workflow_runs: [] }, [`GET repos/${REPO}/actions/runs?event=push&head_sha=def&per_page=1`]: { total_count: 0 } });
    const e = await run('run.await', { workflow: 'ci.yml', event: 'pull_request', pr: 'docs', deadline: 1 }, context({ gh: g.gh, state: { prs: { docs: 5 } } })).catch((x) => x);
    expect(classify(e)).toBe('fail');
    expect(g.calls.map((c) => c.key)).not.toContain(`GET repos/${REPO}/actions/runs?event=push&head_sha=def&per_page=1`);
  });
});

describe('pushRuns: whether a workflow\'s `on:` runs it on a push to a branch (#126)', () => {
  const on = (block) => `name: CI\n${block}\njobs:\n  a:\n    runs-on: ubuntu-latest\n`;
  it.each([
    ['on: push', 'main', 'yes'],
    ['"on": [pull_request, push]', 'main', 'yes'],
    ["'on': pull_request", 'main', 'no'],
    ['on:\n  - pull_request\n  - push # and pushes', 'main', 'yes'],
    ['on:\n  push:\n  workflow_dispatch:', 'main', 'yes'],
    ['on:\n  push: {}', 'main', 'yes'],
    ['on:\n  pull_request:\n    branches: [main]', 'main', 'no'],
    ['on:\n  push:\n    branches: ["main"]', 'main', 'yes'],
    ['on:\n  push:\n    branches:\n      - develop\n      - main', 'main', 'yes'],
    ['on:\n  push:\n    branches: [develop]', 'main', 'no'],
    ['on:\n  push:\n    branches:\n    - main', 'main', 'yes'],
    ['on:\n- push', 'main', 'yes'],
    ["on:\n  push:\n    branches: ['release/**']", 'release/v1/x', 'yes'],
    ["on:\n  push:\n    branches: ['release/*']", 'release/v1/x', 'no'],
    ["on:\n  push:\n    branches: ['**', '!main']", 'main', 'no'],
    ["on:\n  push:\n    branches: ['!main', '**']", 'main', 'yes'],
    ['on:\n  push:\n    branches-ignore: [main]', 'main', 'no'],
    ['on:\n  push:\n    branches-ignore: [develop]', 'main', 'yes'],
    ["on:\n  push:\n    tags: ['v*']", 'main', 'no'],
    ["on:\n  push:\n    branches: [main]\n    tags: ['v*']", 'main', 'yes'],
    ['on:\n  push:\n    paths: [src/**]', 'main', 'unknown'],
    ['on:\n  push:\n    branches: [develop]\n    paths-ignore: [docs/**]', 'main', 'no'],
    ['on: { push: { branches: [main] } }', 'main', 'unknown'],
    ['jobs-only: true', 'main', 'no'],
  ])('%j on %s reads %s', (block, branch, read) => {
    expect(pushRuns(on(block), branch)).toBe(read);
  });
});

describe('expect.run', () => {
  const routes = (conclusion = 'success', jobs = [{ name: 'Lane check', conclusion: 'success' }, { name: 'Tests', conclusion: 'success' }]) => stubGh({
    [`GET repos/${REPO}/actions/runs/5`]: { status: 'completed', conclusion, display_title: 'free text' },
    [`GET repos/${REPO}/actions/runs/5/jobs?per_page=100`]: { jobs },
  });
  const state = { runs: { ci: 5 } };

  it('holds a run to its conclusion and its jobs\' names and conclusions', async () => {
    await run('expect.run', { run: 'ci', conclusion: 'success', jobs: [{ name: 'Lane check', conclusion: 'success' }], deadline: 2 }, context({ gh: routes().gh, state }));
  });

  it('fails on another conclusion, or a job missing or concluded otherwise', async () => {
    await expect(run('expect.run', { run: 'ci', conclusion: 'success', deadline: 1 }, context({ gh: routes('failure').gh, state }))).rejects.toMatchObject(failsWith(/conclusion.*failure/));
    await expect(run('expect.run', { run: 'ci', jobs: [{ name: 'Lint', conclusion: 'success' }], deadline: 1 }, context({ gh: routes().gh, state }))).rejects.toMatchObject(failsWith(/`Lint`/));
    await expect(run('expect.run', { run: 'ci', jobs: [{ name: 'Tests', conclusion: 'skipped' }], deadline: 1 }, context({ gh: routes().gh, state }))).rejects.toMatchObject(failsWith(/`Tests`.*success/));
  });
});

describe('expect.check', () => {
  it('holds a commit\'s check run to a name and a conclusion', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/pulls/5`]: { head: { sha: 'def' } },
      [`GET repos/${REPO}/commits/def/check-runs?check_name=Lane%20check&per_page=100`]: inTurn(
        { check_runs: [{ id: 1, status: 'in_progress', conclusion: null }] },
        { check_runs: [{ id: 1, status: 'completed', conclusion: 'failure' }, { id: 2, status: 'completed', conclusion: 'success' }] },
      ),
    });
    await run('expect.check', { pr: 'docs', name: 'Lane check', conclusion: 'success', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
  });

  it('reads a commit status of that name when no check run has it', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } },
      [`GET repos/${REPO}/commits/abc/check-runs?check_name=implementer&per_page=100`]: { check_runs: [] },
      [`GET repos/${REPO}/commits/abc/status`]: { statuses: [{ context: 'implementer', state: 'success', description: 'free text' }] },
    });
    await run('expect.check', { branch: 'main', name: 'implementer', conclusion: 'success', deadline: 5 }, context({ gh: g.gh }));
    await expect(run('expect.check', { branch: 'main', name: 'implementer', conclusion: 'failure', deadline: 1 }, context({ gh: g.gh }))).rejects.toMatchObject(failsWith(/implementer.*success/));
  });
});

describe('expect.issue', () => {
  const routes = (comments) => stubGh({
    [`GET repos/${REPO}/issues/9`]: { state: 'open', labels: [{ name: 'bug' }, { name: 'sev:low' }], user: { login: 'kanon-e2e-author[bot]' }, body: 'An issue.' },
    [`GET repos/${REPO}/issues/9/comments?per_page=100`]: [comments],
  });
  const state = { issues: { bug: 9 } };

  it('holds an issue to its state, labels, author\'s App slug, and a known marker in a comment', async () => {
    const g = routes([{ body: '**Lead** <!-- kanon:role=lead -->\nAnything at all.', user: { login: 'kanon-e2e-author[bot]' } }]);
    await run('expect.issue', { issue: 'bug', state: 'open', labels: ['bug'], labelsAbsent: ['needs:human'], author: 'kanon-e2e-author', marker: 'role:lead', markerBy: 'kanon-e2e-author', deadline: 5 }, context({ gh: g.gh, state }));
  });

  it('fails on a marker by another author, a missing label or a wrong author', async () => {
    const g = routes([{ body: '<!-- kanon:role=lead -->', user: { login: 'someone' } }]);
    for (const [step, re] of [
      [{ marker: 'role:lead', markerBy: 'kanon-e2e-author' }, /role:lead/],
      [{ labels: ['sev:high'] }, /sev:high/],
      [{ labelsAbsent: ['bug'] }, /bug/],
      [{ author: 'kanon-e2e-judge' }, /author/],
      [{ state: 'closed' }, /state/],
    ]) await expect(run('expect.issue', { issue: 'bug', deadline: 1, ...step }, context({ gh: g.gh, state }))).rejects.toMatchObject(failsWith(re));
  });
});

describe('expect.pr', () => {
  it('holds a pull request to merged, and finds the Reviewer\'s marker in a review', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/pulls/5`]: { state: 'closed', merged: true, labels: [{ name: 'review:please' }], user: { login: 'kanon-e2e-author[bot]' }, body: '**Implementer** <!-- kanon:role=implementer -->' },
      [`GET repos/${REPO}/issues/5/comments?per_page=100`]: [[]],
      [`GET repos/${REPO}/pulls/5/reviews?per_page=100`]: inTurn([[]], [[{ body: '**Reviewer** <!-- kanon:role=reviewer -->\nApproved.', user: { login: 'kanon-e2e-judge[bot]' } }]]),
    });
    await run('expect.pr', { pr: 'docs', state: 'merged', labels: ['review:please'], author: 'kanon-e2e-author', marker: 'role:reviewer', markerBy: 'kanon-e2e-judge', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
  });

  it('finds the release-PR guard\'s marker on a stale release pull request', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/pulls/12`]: { state: 'open', merged: false, labels: [], user: { login: 'kanon-e2e-releaser[bot]' }, body: '' },
      [`GET repos/${REPO}/issues/12/comments?per_page=100`]: [[{ body: `<!-- kanon-release-pr-guard ${'f'.repeat(40)} -->\n**This release PR is stale**`, user: { login: 'github-actions[bot]' } }]],
      [`GET repos/${REPO}/pulls/12/reviews?per_page=100`]: [[]],
    });
    await run('expect.pr', { pr: 'release', state: 'open', marker: 'release-pr-guard', deadline: 5 }, context({ gh: g.gh, state: { prs: { release: 12 } } }));
    await expect(run('expect.pr', { pr: 'release', state: 'merged', deadline: 1 }, context({ gh: g.gh, state: { prs: { release: 12 } } }))).rejects.toMatchObject(failsWith(/state.*merged.*open/));
  });
});

describe('expect.artifact', () => {
  it('holds a run\'s artifact to its name', async () => {
    const g = stubGh({ [`GET repos/${REPO}/actions/runs/5/artifacts?per_page=100`]: inTurn({ artifacts: [] }, { artifacts: [{ name: 'agent-run-row' }] }) });
    await run('expect.artifact', { run: 'ci', name: 'agent-run-row', deadline: 5 }, context({ gh: g.gh, state: { runs: { ci: 5 } } }));
    await expect(run('expect.artifact', { run: 'ci', name: 'other', deadline: 1 }, context({ gh: g.gh, state: { runs: { ci: 5 } } }))).rejects.toMatchObject(failsWith(/other.*agent-run-row/));
  });
});

describe('expect.row', () => {
  const ROW = { schema_version: 2, row_kind: 'run', lane: 'review', outcome: 'ok', reason: 'ok', verdict: 'approved', total_cost_usd: 0.42 };
  /**
   * `gh`, stubbed: the run's artifacts in turn, and `run download` writing `file` (text) into the
   * directory it names, as `gh` does. The other calls go to stubGh.
   */
  const world = ({ names = [['kanon-telemetry-review-5-1']], row = ROW, file = JSON.stringify(row), download = 0, jobs = [] } = {}) => {
    const g = stubGh({
      [`GET repos/${REPO}/actions/runs/5/artifacts?per_page=100`]: inTurn(...names.map((n) => ({ artifacts: n.map((name) => ({ name })) }))),
      [`GET repos/${REPO}/actions/runs/5/jobs?per_page=100`]: { jobs: jobs.map(([name, conclusion], i) => ({ id: 100 + i, name, conclusion })) },
    });
    const downloads = [];
    const gh = async (args, input) => {
      if (args[0] !== 'run') return g.gh(args, input);
      downloads.push(args.filter((a, i) => args[i - 1] !== '-D'));
      if (download) return { status: download, stdout: '', stderr: 'HTTP 404: Not Found' };
      writeFileSync(join(args[args.indexOf('-D') + 1], 'kanon-telemetry.json'), file);
      return { status: 0, stdout: '', stderr: '' };
    };
    return { gh, downloads, calls: g.calls };
  };
  const step = { run: 'review', lane: 'review', ceilingUsd: 30, deadline: 5 };
  const ctxOf = (w, state = {}) => context({ gh: w.gh, state: { runs: { review: 5 }, ...state } });

  it('waits for the lane\'s row, downloads it as data, and keeps its cost in the state for the result', async () => {
    const w = world({ names: [[], ['other'], ['kanon-telemetry-review-5-1', 'kanon-telemetry-review-5-2', 'kanon-telemetry-implement-5-1']] });
    const ctx = ctxOf(w);
    await run('expect.row', step, ctx);
    expect(ctx.state.costUsd).toBe(0.42);
    // The newest attempt's row, from the scenario repository.
    expect(w.downloads).toEqual([['run', 'download', '5', '-R', REPO, '-n', 'kanon-telemetry-review-5-2', '-D']]);
  });

  it('adds a second row\'s cost to the first', async () => {
    const ctx = ctxOf(world({ row: { ...ROW, total_cost_usd: 0.08 } }), { costUsd: 0.42 });
    await run('expect.row', step, ctx);
    expect(ctx.state.costUsd).toBe(0.5);
  });

  it('fails past the lane\'s ceiling, and still keeps the cost, so the ledger sees it', async () => {
    const ctx = ctxOf(world({ row: { ...ROW, total_cost_usd: 31.5 } }));
    await expect(run('expect.row', step, ctx)).rejects.toMatchObject(failsWith(/31\.5 is past the lane's ceiling of \$30/));
    expect(ctx.state.costUsd).toBe(31.5);
  });

  it('reads `outcome: unavailable` as infra, retried and not failed: the model was never reached (§6.2)', async () => {
    const ctx = ctxOf(world({ row: { ...ROW, outcome: 'unavailable', reason: 'model_never_ran', total_cost_usd: 0 } }));
    const e = await run('expect.row', step, ctx).catch((x) => x);
    expect(classify(e)).toBe('infra');
    expect(e.message).toMatch(/never reached.*model_never_ran/);
    expect(ctx.state.costUsd).toBeUndefined();
  });

  it('fails a row with no cost, of another lane or schema, or that isn\'t JSON', async () => {
    for (const [w, re] of [
      [world({ row: { ...ROW, total_cost_usd: undefined } }), /records no cost/],
      [world({ row: { ...ROW, total_cost_usd: -1 } }), /records no cost/],
      [world({ row: { ...ROW, lane: 'implement' } }), /`lane`: expected `review`/],
      [world({ row: { ...ROW, schema_version: 1 } }), /not a version-2 run row/],
      [world({ file: 'not json' }), /no kanon-telemetry\.json that parses/],
      [world({ file: '[1]' }), /not a JSON object/],
    ]) await expect(run('expect.row', step, ctxOf(w))).rejects.toMatchObject(failsWith(re));
  });

  it('fails at its deadline when the run uploads no row, naming what it has', async () => {
    await expect(run('expect.row', { ...step, deadline: 1 }, ctxOf(world({ names: [['reviewer-transcript-pr1-1']] })))).rejects.toMatchObject(failsWith(/no telemetry row.*reviewer-transcript-pr1-1/));
  });

  it('with a `job`, fails at once when that job was skipped: it uploaded no row, so the wait is spent on nothing (harness #105)', async () => {
    const ctx = ctxOf(world({ names: [[]], jobs: [['review / filter', 'success'], ['review / review', 'skipped']] }));
    const start = ctx.now();
    await expect(run('expect.row', { ...step, job: 'review / review' }, ctx)).rejects.toMatchObject(failsWith(/no telemetry row.*job `review \/ review` was skipped/));
    expect(ctx.now()).toBe(start);
  });

  it('with a `job` skipped, names the conclusions of the jobs beside it, from the same jobs call, and none it calls or outside its caller (harness #122)', async () => {
    const w = world({ names: [[]], jobs: [['lint', 'success'], ['review / filter', 'failure'], ['review / review', 'skipped'], ['review / review / mint', 'skipped'], ['review / reviewer', 'skipped']] });
    const e = await run('expect.row', { ...step, job: 'review / review' }, ctxOf(w)).catch((x) => x);
    expect(e).toMatchObject(failsWith(/job `review \/ review` was skipped, so it uploaded none; beside it, `review \/ filter` `failure`, `review \/ reviewer` `skipped`: a job is skipped when one it `needs` didn't succeed, too$/));
    expect(e.message).not.toMatch(/lint|mint/);
    expect(w.calls.filter((c) => c.key.includes('/jobs'))).toHaveLength(1);
  });

  it('with a `job`, names its conclusion and its called jobs\' at the deadline when the run uploads no row', async () => {
    const jobs = [['review / filter', 'success'], ['review / review / mint', 'success'], ['review / review / review / review', 'failure'], ['review / reviewer', 'skipped']];
    const e = await run('expect.row', { ...step, job: 'review / review', deadline: 1 }, ctxOf(world({ names: [[]], jobs }))).catch((x) => x);
    expect(e).toMatchObject(failsWith(/deadline.*no telemetry row.*`review \/ review \/ mint` `success`, `review \/ review \/ review \/ review` `failure`/));
    expect(e.message).not.toMatch(/reviewer|filter/);
    await expect(run('expect.row', { ...step, job: 'review / review', deadline: 1 }, ctxOf(world({ names: [[]], jobs: [['review / filter', 'success']] })))).rejects.toMatchObject(failsWith(/job `review \/ review`: not in the run/));
  });

  it('with a `job`, reads no jobs when the row is there', async () => {
    const w = world({ jobs: [['review / review', 'skipped']] });
    const ctx = ctxOf(w);
    await run('expect.row', { ...step, job: 'review / review' }, ctx);
    expect(ctx.state.costUsd).toBe(0.42);
    expect(w.calls.map((c) => c.key).filter((k) => k.includes('/jobs'))).toEqual([]);
  });

  it('a failed download is GitHub\'s, for the runner to classify, never a pass', async () => {
    const e = await run('expect.row', step, ctxOf(world({ download: 1 }))).catch((x) => x);
    expect(e).toMatchObject({ name: 'GhError' });
  });
});

describe('expect.api', () => {
  it('makes one GET of the scenario repository\'s own API per try, and holds a JSON value at a pointer', async () => {
    const g = stubGh({ [`GET repos/${REPO}/rulesets`]: inTurn([], [{ name: 'Kanon: default branch' }]) });
    const ctx = context({ gh: g.gh });
    await run('expect.api', { path: 'repos/{{repository}}/rulesets', pointer: '/0/name', equals: 'Kanon: default branch', deadline: 5 }, ctx);
    expect(g.calls.map((c) => c.key)).toEqual([`GET repos/${REPO}/rulesets`, `GET repos/${REPO}/rulesets`]);
  });

  it('compares arrays by value, and fails naming the pointer, the value expected and the value read', async () => {
    const g = stubGh({ [`GET repos/${REPO}`]: { allow_squash_merge: true, topics: ['kanon-e2e'] } });
    await run('expect.api', { path: 'repos/{{repository}}/', pointer: '/topics', equals: ['kanon-e2e'], deadline: 1 }, context({ gh: g.gh }));
    await expect(run('expect.api', { path: 'repos/{{repository}}/', pointer: '/allow_squash_merge', equals: false, deadline: 1 }, context({ gh: g.gh })))
      .rejects.toMatchObject(failsWith(/\/allow_squash_merge.*false.*true/));
  });

  it('waits through a 404 for a resource a workflow creates later, and holds it once it appears (#19)', async () => {
    const g = stubGh({ [`GET repos/${REPO}/branches/release`]: inTurn(fail('gh: Not Found (HTTP 404)'), fail('gh: Not Found (HTTP 404)'), { name: 'release' }) });
    const ctx = context({ gh: g.gh });
    await run('expect.api', { path: 'repos/{{repository}}/branches/release', pointer: '/name', equals: 'release', deadline: 5 }, ctx);
    expect(g.calls).toHaveLength(3);
    expect(ctx.clock.sleeps).toEqual([2000, 4000]);
  });

  it('fails as `Fail` at its deadline when the resource never appears, naming the 404 it last saw (#19)', async () => {
    const g = stubGh({ [`GET repos/${REPO}/branches/release`]: fail('gh: Not Found (HTTP 404)') });
    const ctx = context({ gh: g.gh });
    const start = ctx.now();
    const e = await run('expect.api', { path: 'repos/{{repository}}/branches/release', pointer: '/name', equals: 'release', deadline: 1 }, ctx).catch((x) => x);
    expect(e).toMatchObject(failsWith(/deadline of 1 minute.*branches\/release.*HTTP 404/));
    expect(classify(e)).toBe('fail');
    expect(ctx.now() - start).toBe(60_000);
  });

  it('leaves any other `gh` error to the runner (#16): a 502 the retries outlast is thrown at once and reads `infra`', async () => {
    const g = stubGh({ [`GET repos/${REPO}/branches/release`]: fail('gh: Server Error (HTTP 502)') });
    const ctx = context({ gh: g.gh });
    const e = await run('expect.api', { path: 'repos/{{repository}}/branches/release', pointer: '/name', equals: 'release', deadline: 5 }, ctx).catch((x) => x);
    expect(e.name).toBe('GhError');
    expect(classify(e)).toBe('infra');
    expect(g.calls).toHaveLength(1);
    expect(ctx.clock.sleeps).toEqual([]);
  });

  it('refuses at run time too a path outside the scenario repository, calling nothing', async () => {
    const g = stubGh({});
    await expect(run('expect.api', { path: 'repos/yedeya-labs/kanon/releases', pointer: '/0/id', equals: 1, deadline: 1 }, context({ gh: g.gh }))).rejects.toThrow(/scenario repository's own API/);
    expect(g.calls).toEqual([]);
  });
});

describe('issue.await', () => {
  const ISSUES = `GET repos/${REPO}/issues?state=all&per_page=100`;
  const issue = (number, login, labels, pr = false) => ({ number, user: { login }, labels: labels.map((name) => ({ name })), ...(pr ? { pull_request: {} } : {}) });

  it('waits for an issue by an App\'s slug with every label, and keeps the newest under its name', async () => {
    const g = stubGh({
      [ISSUES]: inTurn([[]], [[
        issue(7, 'github-actions[bot]', ['bug', 'sev:medium']),
        issue(6, 'github-actions[bot]', ['bug', 'sev:medium'], true),
        issue(5, 'github-actions[bot]', ['bug', 'sev:medium']),
        issue(8, 'github-actions[bot]', ['bug']),
        issue(9, 'kanon-e2e-author[bot]', ['bug', 'sev:medium']),
      ]]),
    });
    const ctx = context({ gh: g.gh });
    await run('issue.await', { name: 'staging-failed', author: 'github-actions', labels: ['bug', 'sev:medium'], deadline: 5 }, ctx);
    expect(ctx.state.issues).toEqual({ 'staging-failed': 7 });
    expect(g.writes()).toEqual([]);
  });

  it('never takes a pull request for an issue', async () => {
    const g = stubGh({ [ISSUES]: [[issue(6, 'github-actions[bot]', ['bug'], true)]] });
    await expect(run('issue.await', { name: 'x', author: 'github-actions', deadline: 1 }, context({ gh: g.gh })))
      .rejects.toMatchObject(failsWith(/github-actions\[bot\]/));
  });

  it('fails at the deadline, naming what it waited for', async () => {
    const g = stubGh({ [ISSUES]: [[issue(5, 'someone', ['bug', 'sev:medium'])]] });
    await expect(run('issue.await', { name: 'x', author: 'github-actions', labels: ['bug', 'sev:medium'], deadline: 1 }, context({ gh: g.gh })))
      .rejects.toMatchObject(failsWith(/bug, sev:medium/));
  });

  it('takes no title or body to match: an App\'s slug and labels alone (§4.3)', () => {
    expect(Object.keys(VOCABULARY['issue.await'].args).sort()).toEqual(['author', 'labels', 'name']);
  });
});
