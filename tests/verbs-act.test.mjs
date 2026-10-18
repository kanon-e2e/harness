import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { REPO, RELEASE, context, fail, inTurn, stubExec, stubGh, tempDir, writeTree } from './helpers/stubs.mjs';

/**
 * The verbs of an `act` segment (Kanon plan 0012 §4.2): each writes to the scenario repository
 * with the harness's own code, on a stubbed `gh` (and, for `files.commit`, a stubbed `git`).
 */

const run = (verb, step, ctx) => VOCABULARY[verb].run({ verb, ...step }, ctx);
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');

describe('repo.apply', () => {
  const finding = (id) => ({ id, category: id.split('.')[0], blocking: false, subject: REPO, message: 'm', fix: { text: 't', commands: [], url: null } });
  const kept = (ids, mergeQueue = 'yes') => ({ documents: { init: { release: RELEASE, exit: 0, document: { schema: 'kanon-init/v1', status: 'steps-left', inspection: { mergeQueue }, findings: ids.map(finding) } } } });
  const RULESET = { id: 7, name: 'Kanon: default branch', rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] };
  const routes = (over = {}) => ({
    [`PATCH repos/${REPO}`]: {},
    [`GET repos/yedeya-labs/kanon/contents/requirements.json?ref=${RELEASE}`]: { encoding: 'base64', content: b64({ labels: ['bug', 'review:please', 'signal:<name>', 'project:<n>', 'autorelease: pending'] }) },
    [`GET repos/${REPO}/labels?per_page=100`]: [[{ name: 'bug' }]],
    [`POST repos/${REPO}/labels`]: {},
    [`GET repos/${REPO}/milestones?state=all&per_page=100`]: [[{ title: 'Product Backlog' }]],
    [`POST repos/${REPO}/milestones`]: {},
    [`GET repos/${REPO}/rulesets?per_page=100`]: [[]],
    [`POST repos/${REPO}/rulesets`]: { id: 7 },
    ...over,
  });
  const ALL = ['merge.settings', 'label.create', 'milestone.buckets', 'ruleset.create', 'ruleset.require-check', 'app.create'];

  it('first call: squash-only merging, the release\'s labels, the bucket milestones and the ruleset, as K-ADOPT-1 steps 5 to 8 state them', async () => {
    const g = stubGh(routes());
    const ctx = context({ gh: g.gh, state: kept(ALL) });
    await run('repo.apply', {}, ctx);
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([
      [`PATCH repos/${REPO}`, { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' }],
      [`POST repos/${REPO}/labels`, { name: 'review:please' }],
      [`POST repos/${REPO}/labels`, { name: 'autorelease: pending' }],
      [`POST repos/${REPO}/milestones`, { title: 'Development Automation' }],
      [`POST repos/${REPO}/rulesets`, expect.objectContaining({ name: 'Kanon: default branch', target: 'branch', enforcement: 'active' })],
    ]);
    const ruleset = g.writes().at(-1).body;
    expect(ruleset.conditions).toEqual({ ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } });
    expect(ruleset.rules.map((r) => r.type)).toEqual(['deletion', 'non_fast_forward', 'pull_request', 'merge_queue']);
    const pr = ruleset.rules.find((r) => r.type === 'pull_request').parameters;
    expect(pr.allowed_merge_methods).toEqual(['squash']);
    expect(pr.required_approving_review_count).toBe(0);
    expect(ctx.state.applied).toEqual(['merge.settings', 'label.create', 'milestone.buckets', 'ruleset.create']);
  });

  it('leaves the merge queue out where the plan has none', async () => {
    const g = stubGh(routes());
    await run('repo.apply', {}, context({ gh: g.gh, state: kept(['ruleset.create'], 'no') }));
    expect(g.writes()[0].body.rules.map((r) => r.type)).toEqual(['deletion', 'non_fast_forward', 'pull_request']);
  });

  it('applies only what the kept init document\'s findings name', async () => {
    const g = stubGh(routes());
    await run('repo.apply', {}, context({ gh: g.gh, state: kept(['label.create', 'app.create']) }));
    expect(g.writes().map((c) => c.key)).toEqual([`POST repos/${REPO}/labels`, `POST repos/${REPO}/labels`]);
    const none = stubGh(routes());
    await run('repo.apply', {}, context({ gh: none.gh, state: kept([]) }));
    expect(none.calls).toEqual([]);
  });

  it('second call: adds only the ruleset\'s required `Lane check` rule', async () => {
    const g = stubGh(routes({
      [`GET repos/${REPO}/rulesets?per_page=100`]: [[{ id: 7, name: 'Kanon: default branch' }]],
      [`GET repos/${REPO}/rulesets/7`]: RULESET,
      [`PUT repos/${REPO}/rulesets/7`]: {},
    }));
    const ctx = context({ gh: g.gh, state: { ...kept(ALL), repoApply: 1 } });
    await run('repo.apply', {}, ctx);
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([[`PUT repos/${REPO}/rulesets/7`, {
      rules: [...RULESET.rules, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'Lane check' }] } }],
    }]]);
    expect(ctx.state.repoApply).toBe(2);
  });

  it('second call: fails by name when the ruleset isn\'t there', async () => {
    const g = stubGh(routes({ [`GET repos/${REPO}/rulesets?per_page=100`]: [[]] }));
    await expect(run('repo.apply', {}, context({ gh: g.gh, state: { ...kept(['ruleset.require-check']), repoApply: 1 } }))).rejects.toThrow(/Kanon: default branch/);
  });

  it('refuses without a kept init document, and a third call', async () => {
    await expect(run('repo.apply', {}, context())).rejects.toThrow(/no kept `kanon init` document/);
    await expect(run('repo.apply', {}, context({ state: { ...kept([]), repoApply: 2 } }))).rejects.toThrow(/third/);
  });

  it('skips a ruleset that already exists, rather than making a second', async () => {
    const g = stubGh(routes({ [`GET repos/${REPO}/rulesets?per_page=100`]: [[{ id: 7, name: 'Kanon: default branch' }]] }));
    await run('repo.apply', {}, context({ gh: g.gh, state: kept(['ruleset.create']) }));
    expect(g.writes()).toEqual([]);
  });
});

describe('files.commit', () => {
  const git = (x) => x.calls.filter((c) => c.cmd === 'git').map((c) => c.args.filter((a) => !a.startsWith('user.')).join(' '));

  it('commits files from the scenario\'s directory, deletes paths, on a new branch, and pushes it, running git only in its own clone', async () => {
    const clone = tempDir('clone-');
    const dir = writeTree(tempDir('scenario-'), { 'files/fix/docs/a.md': 'a line\n' });
    const x = stubExec([[(c) => c.args.includes('ls-remote'), () => ({ status: 2 })]]);
    await run('files.commit', { from: 'scenario', dir: 'files/fix', delete: ['docs/old.md'], branch: 'docs', message: 'docs: a line' }, context({ exec: x.exec, clone, scenarioDir: dir }));
    expect(readFileSync(join(clone, 'docs/a.md'), 'utf8')).toBe('a line\n');
    expect(git(x)).toEqual([
      'fetch -q origin',
      'ls-remote --exit-code --heads origin docs',
      'checkout -q -B docs origin/main',
      'rm -r -q --ignore-unmatch -- docs/old.md',
      'add -A',
      '-c -c commit -q -m docs: a line',
      'push -q origin HEAD:refs/heads/docs',
    ]);
    expect(x.calls.every((c) => c.cwd === clone)).toBe(true);
  });

  it('adds to a branch that exists, from its own head', async () => {
    const x = stubExec();
    await run('files.commit', { delete: ['a.md'], branch: 'docs', message: 'm' }, context({ exec: x.exec, clone: tempDir() }));
    expect(git(x)).toContain('checkout -q -B docs origin/docs');
  });

  it('commits the files the kanon segment left, taken as data, on the default branch', async () => {
    const clone = tempDir('clone-');
    const x = stubExec();
    const kanonFiles = [{ path: '.github/workflows/ci.yml', bytes: Buffer.from('on: push\n') }];
    await run('files.commit', { from: 'kanon', message: 'Install Kanon' }, context({ exec: x.exec, clone, kanonFiles }));
    expect(readFileSync(join(clone, '.github/workflows/ci.yml'), 'utf8')).toBe('on: push\n');
    expect(git(x)).toContain('checkout -q -B main origin/main');
    expect(git(x).at(-1)).toBe('push -q origin HEAD:refs/heads/main');
  });

  it('refuses a crossing path outside the clone or under .git/, writing nothing', async () => {
    for (const path of ['../escape', '.git/hooks/pre-push', '/etc/x', 'a/../../b']) {
      const clone = tempDir('clone-');
      const x = stubExec();
      await expect(run('files.commit', { from: 'kanon', message: 'm' }, context({ exec: x.exec, clone, kanonFiles: [{ path, bytes: Buffer.from('x') }] }))).rejects.toThrow(/refus/);
      expect(existsSync(join(clone, '.git/hooks/pre-push'))).toBe(false);
    }
  });

  it('refuses to write through a symlink the checked-out branch holds, writing nothing', async () => {
    const away = tempDir('away-');
    for (const [link, path] of [['x', 'x/.gitconfig'], ['x', 'x'], ['a/x', 'a/x/b/c.md']]) {
      const clone = tempDir('clone-');
      mkdirSync(dirname(join(clone, link)), { recursive: true });
      symlinkSync(away, join(clone, link));
      const x = stubExec();
      await expect(run('files.commit', { from: 'kanon', message: 'm' }, context({ exec: x.exec, clone, kanonFiles: [{ path: 'ok.md', bytes: Buffer.from('x') }, { path, bytes: Buffer.from('x') }] }))).rejects.toThrow(/refused: .* symlink/);
      expect(readdirSync(away)).toEqual([]);
      expect(existsSync(join(clone, 'ok.md'))).toBe(false);
      expect(git(x)).not.toContain('add -A');
    }
  });

  it('fails when git does', async () => {
    const x = stubExec([[(c) => c.args.includes('push'), () => ({ status: 1, stderr: 'rejected' })]]);
    await expect(run('files.commit', { delete: ['a'], message: 'm' }, context({ exec: x.exec, clone: tempDir() }))).rejects.toThrow(/git push.*rejected/);
  });
});

describe('pr.open', () => {
  it('opens a pull request from a branch and keeps its number under its name', async () => {
    const g = stubGh({ [`POST repos/${REPO}/pulls`]: { number: 5 } });
    const ctx = context({ gh: g.gh });
    await run('pr.open', { name: 'docs', head: 'docs', title: 'docs: a line', body: 'One line.' }, ctx);
    expect(g.writes()[0].body).toEqual({ title: 'docs: a line', head: 'docs', base: 'main', body: 'One line.' });
    expect(ctx.state.prs).toEqual({ docs: 5 });
  });
});

describe('pr.label', () => {
  it('adds and removes labels', async () => {
    const g = stubGh({ [`POST repos/${REPO}/issues/5/labels`]: [], [`DELETE repos/${REPO}/issues/5/labels/needs%3Ahuman`]: undefined });
    await run('pr.label', { pr: 'docs', add: ['review:please'], remove: ['needs:human'] }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([
      [`POST repos/${REPO}/issues/5/labels`, { labels: ['review:please'] }],
      [`DELETE repos/${REPO}/issues/5/labels/needs%3Ahuman`, undefined],
    ]);
  });
});

describe('pr.merge', () => {
  const pulls = (...answers) => ({ [`GET repos/${REPO}/pulls/5`]: inTurn(...answers) });

  it('through the front door: squash with auto-merge, then polls until merged', async () => {
    const g = stubGh({ [`pr merge 5 -R ${REPO} --squash --auto`]: undefined, ...pulls({ state: 'open', merged: false }, { state: 'closed', merged: true }) });
    const ctx = context({ gh: g.gh, state: { prs: { docs: 5 } } });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, ctx);
    expect(ctx.clock.sleeps).toEqual([2000]);
  });

  it('merges at once where the pull request is already clean', async () => {
    const g = stubGh({
      [`pr merge 5 -R ${REPO} --squash --auto`]: fail('Pull request is in clean status'),
      [`pr merge 5 -R ${REPO} --squash`]: undefined,
      ...pulls({ state: 'closed', merged: true }),
    });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
    expect(g.calls.map((c) => c.key)).toContain(`pr merge 5 -R ${REPO} --squash`);
  });

  it('as the driver, where the ruleset lets a bypass actor through', async () => {
    const g = stubGh({ [`pr merge 5 -R ${REPO} --squash --admin`]: undefined, ...pulls({ state: 'closed', merged: true }) });
    await run('pr.merge', { pr: 'docs', via: 'bypass', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
    expect(g.calls[0].key).toBe(`pr merge 5 -R ${REPO} --squash --admin`);
  });

  it('fails when the pull request closes unmerged, or the deadline passes', async () => {
    const closed = stubGh({ [`pr merge 5 -R ${REPO} --squash --auto`]: undefined, ...pulls({ state: 'closed', merged: false }) });
    await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: closed.gh, state: { prs: { docs: 5 } } }))).rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/closed without merging/) });
    const open = stubGh({ [`pr merge 5 -R ${REPO} --squash --auto`]: undefined, ...pulls({ state: 'open', merged: false }) });
    await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 1 }, context({ gh: open.gh, state: { prs: { docs: 5 } } }))).rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/deadline/) });
  });
});

describe('issue.open', () => {
  it('opens an issue with its labels and keeps its number under its name', async () => {
    const g = stubGh({ [`POST repos/${REPO}/issues`]: { number: 9 } });
    const ctx = context({ gh: g.gh });
    await run('issue.open', { name: 'bug', title: 'A bug', labels: ['bug'] }, ctx);
    expect(g.writes()[0].body).toEqual({ title: 'A bug', body: '', labels: ['bug'] });
    expect(ctx.state.issues).toEqual({ bug: 9 });
  });
});

describe('issue.label', () => {
  it('adds labels', async () => {
    const g = stubGh({ [`POST repos/${REPO}/issues/9/labels`]: [] });
    await run('issue.label', { issue: 'bug', add: ['sev:low'] }, context({ gh: g.gh, state: { issues: { bug: 9 } } }));
    expect(g.writes()[0].body).toEqual({ labels: ['sev:low'] });
  });
});

describe('workflow.dispatch', () => {
  it('dispatches a workflow on the default branch, with its inputs', async () => {
    const g = stubGh({ [`POST repos/${REPO}/actions/workflows/apps-check.yml/dispatches`]: undefined });
    await run('workflow.dispatch', { workflow: 'apps-check.yml', inputs: { reason: 'scenario' } }, context({ gh: g.gh }));
    expect(g.writes()[0].body).toEqual({ ref: 'main', inputs: { reason: 'scenario' } });
  });
});

describe('release.cut', () => {
  it('merges the release pull request, then waits for the Release the test Releaser publishes', async () => {
    const g = stubGh({
      [`GET repos/${REPO}/pulls?state=open&per_page=100`]: inTurn([[]], [[{ number: 3, labels: [{ name: 'feature' }] }, { number: 12, labels: [{ name: 'autorelease: pending' }] }]]),
      [`pr merge 12 -R ${REPO} --squash --auto`]: undefined,
      [`GET repos/${REPO}/pulls/12`]: { state: 'closed', merged: true, merged_at: '2026-10-17T10:00:00Z' },
      [`GET repos/${REPO}/releases?per_page=20`]: inTurn([], [
        { id: 1, tag_name: 'v0.0.9', draft: false, created_at: '2026-10-16T10:00:00Z', published_at: '2026-10-16T10:01:00Z', author: { login: 'kanon-e2e-releaser[bot]' } },
        { id: 2, tag_name: 'v0.1.0', draft: true, created_at: '2026-10-17T09:59:00Z', published_at: null, author: { login: 'kanon-e2e-releaser[bot]' } },
        { id: 3, tag_name: 'v0.1.0', draft: false, created_at: '2026-10-17T09:59:00Z', published_at: '2026-10-17T10:01:00Z', author: { login: 'someone' } },
      ], [
        // GitHub's own shape (this repository's v0.1.0): `created_at` is the tagged commit's date,
        // which a merge queue builds before `merged_at`; `published_at` is when it was published.
        { id: 4, tag_name: 'v0.1.0', draft: false, created_at: '2026-10-17T09:59:08Z', published_at: '2026-10-17T10:00:08Z', author: { login: 'kanon-e2e-releaser[bot]' } },
      ]),
    });
    const ctx = context({ gh: g.gh });
    await run('release.cut', { deadline: 30 }, ctx);
    expect(ctx.state.prs).toEqual({ release: 12 });
    expect(ctx.state.release).toEqual({ id: 4, tag: 'v0.1.0' });
  });
});

describe('deployment.await-approval', () => {
  const waiting = {
    [`GET repos/${REPO}/actions/runs?status=waiting&per_page=100`]: inTurn({ workflow_runs: [] }, { workflow_runs: [{ id: 76, path: '.github/workflows/ci.yml' }, { id: 77, path: '.github/workflows/deploy.yml' }] }),
    [`GET repos/${REPO}/actions/runs/76/pending_deployments`]: [{ environment: { name: 'staging' } }],
    [`GET repos/${REPO}/actions/runs/77/pending_deployments`]: [{ environment: { name: 'production' } }],
  };

  const JOBS = `GET repos/${REPO}/actions/runs/77/jobs?per_page=100`;
  const job = (status, conclusion = null) => ({ jobs: [
    { id: 4, name: 'staging / deploy', status: 'completed', conclusion: 'success' },
    { id: 5, name: 'production / deploy', status, conclusion },
  ] });

  it('nightly: waits until the environment\'s job is waiting, cancels the run, and holds that job to `cancelled`', async () => {
    const g = stubGh({
      ...waiting,
      [JOBS]: inTurn(job('queued'), job('waiting'), job('waiting'), job('completed', 'cancelled')),
      [`POST repos/${REPO}/actions/runs/77/cancel`]: {},
    });
    const ctx = context({ gh: g.gh, trigger: 'nightly' });
    await run('deployment.await-approval', { environment: 'production', workflow: 'deploy.yml', deadline: 30 }, ctx);
    expect(g.writes().map((c) => c.key)).toEqual([`POST repos/${REPO}/actions/runs/77/cancel`]);
    expect(ctx.state.approvals).toEqual({ production: { run: 77, decision: 'cancelled', jobs: ['production / deploy'] } });
  });

  it('a dispatch: cancels as a nightly does', async () => {
    const g = stubGh({ ...waiting, [JOBS]: inTurn(job('waiting'), job('completed', 'cancelled')), [`POST repos/${REPO}/actions/runs/77/cancel`]: {} });
    const ctx = context({ gh: g.gh, trigger: 'dispatch' });
    await run('deployment.await-approval', { environment: 'production', deadline: 30 }, ctx);
    expect(ctx.state.approvals.production.decision).toBe('cancelled');
  });

  it('fails when the waiting job ends other than `cancelled` once the run is cancelled', async () => {
    const g = stubGh({ ...waiting, [JOBS]: inTurn(job('waiting'), job('completed', 'success')), [`POST repos/${REPO}/actions/runs/77/cancel`]: {} });
    await expect(run('deployment.await-approval', { environment: 'production', deadline: 30 }, context({ gh: g.gh })))
      .rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/production \/ deploy.*success/) });
  });

  it('fails when the waiting job hasn\'t ended by the deadline', async () => {
    const g = stubGh({ ...waiting, [JOBS]: job('waiting'), [`POST repos/${REPO}/actions/runs/77/cancel`]: {} });
    await expect(run('deployment.await-approval', { environment: 'production', deadline: 2 }, context({ gh: g.gh })))
      .rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/production \/ deploy/) });
  });

  it('a candidate\'s run: files the Owner\'s approval request in the harness, and waits for the decision', async () => {
    const g = stubGh({
      ...waiting,
      [JOBS]: job('waiting'),
      'POST repos/kanon-e2e/harness/issues': { number: 3 },
      [`GET repos/${REPO}/actions/runs/77/approvals`]: inTurn([], [{ state: 'approved', environments: [{ name: 'production' }] }]),
      'PATCH repos/kanon-e2e/harness/issues/3': {},
    });
    const ctx = context({ gh: g.gh, trigger: 'candidate' });
    await run('deployment.await-approval', { environment: 'production', deadline: 30 }, ctx);
    const filed = g.writes()[0];
    expect(filed.key).toBe('POST repos/kanon-e2e/harness/issues');
    expect(filed.body.body).toContain(`https://github.com/${REPO}/actions/runs/77`);
    expect(filed.body.body).toContain(RELEASE);
    expect(g.writes().at(-1)).toMatchObject({ key: 'PATCH repos/kanon-e2e/harness/issues/3', body: { state: 'closed' } });
    expect(ctx.state.approvals).toEqual({ production: { run: 77, decision: 'approved', jobs: ['production / deploy'] } });
  });

  it('fails when no job waits on the environment by the deadline', async () => {
    const g = stubGh({ [`GET repos/${REPO}/actions/runs?status=waiting&per_page=100`]: { workflow_runs: [] } });
    await expect(run('deployment.await-approval', { environment: 'production', deadline: 1 }, context({ gh: g.gh }))).rejects.toMatchObject({ name: 'Fail' });
  });
});

describe('environment.create', () => {
  const ENV = `PUT repos/${REPO}/environments/production`;
  const POLICIES = `repos/${REPO}/environments/production/deployment-branch-policies`;

  it('creates the environment with the release tags alone as its refs, no admin bypass, and the Owner as its required reviewer with self-review prevented', async () => {
    const g = stubGh({
      'GET users/yedeya': { id: 41, login: 'yedeya' },
      [ENV]: {},
      [`GET ${POLICIES}?per_page=100`]: { total_count: 0, branch_policies: [] },
      [`POST ${POLICIES}`]: {},
    });
    await run('environment.create', { name: 'production', tags: 'v*.*.*', reviewer: true }, context({ gh: g.gh }));
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([
      [ENV, { wait_timer: 0, prevent_self_review: true, reviewers: [{ type: 'User', id: 41 }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, can_admins_bypass: false }],
      [`POST ${POLICIES}`, { name: 'v*.*.*', type: 'tag' }],
    ]);
  });

  it('without a reviewer, names none, and reads no user', async () => {
    const g = stubGh({
      [`PUT repos/${REPO}/environments/staging`]: {},
      [`GET repos/${REPO}/environments/staging/deployment-branch-policies?per_page=100`]: { total_count: 0, branch_policies: [] },
      [`POST repos/${REPO}/environments/staging/deployment-branch-policies`]: {},
    });
    await run('environment.create', { name: 'staging', tags: 'v*.*.*' }, context({ gh: g.gh }));
    expect(g.calls.some((c) => c.path.startsWith('users/'))).toBe(false);
    expect(g.writes()[0].body).toEqual({ wait_timer: 0, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, can_admins_bypass: false });
  });

  it('adds the tag rule only once', async () => {
    const g = stubGh({
      [`PUT repos/${REPO}/environments/staging`]: {},
      [`GET repos/${REPO}/environments/staging/deployment-branch-policies?per_page=100`]: { total_count: 1, branch_policies: [{ name: 'v*.*.*', type: 'tag' }] },
    });
    await run('environment.create', { name: 'staging', tags: 'v*.*.*' }, context({ gh: g.gh }));
    expect(g.writes().map((c) => c.key)).toEqual([`PUT repos/${REPO}/environments/staging`]);
  });

  it('takes a branch rule of the same pattern for no tag rule', async () => {
    const g = stubGh({
      [`PUT repos/${REPO}/environments/staging`]: {},
      [`GET repos/${REPO}/environments/staging/deployment-branch-policies?per_page=100`]: { total_count: 1, branch_policies: [{ name: 'v*.*.*', type: 'branch' }] },
      [`POST repos/${REPO}/environments/staging/deployment-branch-policies`]: {},
    });
    await run('environment.create', { name: 'staging', tags: 'v*.*.*' }, context({ gh: g.gh }));
    expect(g.writes().at(-1)).toMatchObject({ key: `POST repos/${REPO}/environments/staging/deployment-branch-policies`, body: { name: 'v*.*.*', type: 'tag' } });
  });

  it('reads the reviewer\'s login from runner/settings.json, not from the scenario', () => {
    const settings = JSON.parse(readFileSync(new URL('../runner/settings.json', import.meta.url), 'utf8'));
    expect(settings.environmentReviewer).toBe('yedeya');
    expect(settings.$sources.environmentReviewer).toMatch(/decision 9/);
    expect(Object.keys(VOCABULARY['environment.create'].args).sort()).toEqual(['name', 'reviewer', 'tags']);
  });
});

describe('ruleset.tags', () => {
  const routes = (have = []) => ({
    [`GET repos/${REPO}/rulesets?per_page=100`]: [have],
    'GET apps/kanon-e2e-releaser': { id: 900, slug: 'kanon-e2e-releaser' },
    [`POST repos/${REPO}/rulesets`]: { id: 8 },
  });

  it('creates an active tag ruleset on the pattern with the creation, update and deletion rules, the named test Apps bypassing it', async () => {
    const g = stubGh(routes());
    await run('ruleset.tags', { pattern: 'v*.*.*', bypass: ['releaser'] }, context({ gh: g.gh }));
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([[`POST repos/${REPO}/rulesets`, {
      name: 'Release tags', target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*.*.*'], exclude: [] } },
      rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
      bypass_actors: [{ actor_id: 900, actor_type: 'Integration', bypass_mode: 'always' }],
    }]]);
  });

  it('creates nothing when the repository already has it', async () => {
    const g = stubGh(routes([{ id: 8, name: 'Release tags', target: 'tag' }]));
    await run('ruleset.tags', { pattern: 'v*.*.*', bypass: ['releaser'] }, context({ gh: g.gh }));
    expect(g.writes()).toEqual([]);
  });
});
