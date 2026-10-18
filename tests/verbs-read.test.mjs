import { describe, expect, it } from 'vitest';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { REPO, RELEASE, context, inTurn, stubGh } from './helpers/stubs.mjs';

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

  it('holds a field at a pointer', async () => {
    await run('expect.doctor', { unchecked: ['secrets'], fields: [{ pointer: '/releases/pinned', equals: RELEASE }] }, context({ state: doctor(PROBE_19) }));
    await expect(run('expect.doctor', { unchecked: ['secrets'], fields: [{ pointer: '/releases/pinned', equals: 'v0.40.0' }] }, context({ state: doctor(PROBE_19) }))).rejects.toMatchObject(failsWith(/\/releases\/pinned/));
  });

  it('refuses without a kept document', async () => {
    await expect(run('expect.doctor', {}, context())).rejects.toThrow(/no kept `kanon doctor` document/);
  });
});

describe('expect.init', () => {
  it('holds the kept document to a status, an exit code and finding ids present and absent', async () => {
    await run('expect.init', { status: 'steps-left', exitCode: 0, findings: ['label.create'], absent: ['app.failed'], fields: [{ pointer: '/pin', equals: RELEASE }] }, context({ state: init() }));
    await expect(run('expect.init', { status: 'complete', findings: ['app.failed'] }, context({ state: init() }))).rejects.toMatchObject(failsWith(/status.*app\.failed/s));
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

  it('fails when the deadline passes', async () => {
    const g = stubGh({ [`GET repos/${REPO}/branches/main`]: { commit: { sha: 'abc' } }, [RUNS]: { workflow_runs: [] } });
    await expect(run('run.await', { workflow: 'ci.yml', event: 'push', branch: 'main', deadline: 1 }, context({ gh: g.gh }))).rejects.toMatchObject(failsWith(/deadline.*no run/));
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
