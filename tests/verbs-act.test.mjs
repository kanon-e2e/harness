import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, retrying } from '../runner/lib/retry.mjs';
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

  describe('`firstCommit`: init reported `ruleset.first-commit`, and the scenario pushed the first commit before this call', () => {
    const APPLIED = ['label.create', 'milestone.buckets', 'ruleset.first-commit'];

    it('first call: creates the ruleset init would on its run after the first commit (K-ADOPT-4)', async () => {
      const g = stubGh(routes());
      const ctx = context({ gh: g.gh, state: kept(APPLIED) });
      await run('repo.apply', { firstCommit: true }, ctx);
      expect(g.writes().at(-1)).toMatchObject({ key: `POST repos/${REPO}/rulesets`, body: expect.objectContaining({ name: 'Kanon: default branch' }) });
      expect(ctx.state.applied).toEqual(['label.create', 'milestone.buckets', 'ruleset.create']);
    });

    it('second call: adds the ruleset\'s required `Lane check` rule', async () => {
      const g = stubGh(routes({
        [`GET repos/${REPO}/rulesets?per_page=100`]: [[{ id: 7, name: 'Kanon: default branch' }]],
        [`GET repos/${REPO}/rulesets/7`]: RULESET,
        [`PUT repos/${REPO}/rulesets/7`]: {},
      }));
      const ctx = context({ gh: g.gh, state: { ...kept(APPLIED), repoApply: 1 } });
      await run('repo.apply', { firstCommit: true }, ctx);
      expect(g.writes().map((c) => c.key)).toEqual([`PUT repos/${REPO}/rulesets/7`]);
      expect(ctx.state.applied).toEqual(['ruleset.require-check']);
    });

    it('without it, `ruleset.first-commit` applies no ruleset, as before', async () => {
      const g = stubGh(routes());
      const ctx = context({ gh: g.gh, state: kept(APPLIED) });
      await run('repo.apply', {}, ctx);
      expect(g.writes().map((c) => c.key)).not.toContain(`POST repos/${REPO}/rulesets`);
      expect(ctx.state.applied).toEqual(['label.create', 'milestone.buckets']);
    });

    it('adds nothing where init reported no `ruleset.first-commit`', async () => {
      const g = stubGh(routes());
      const ctx = context({ gh: g.gh, state: kept(['label.create']) });
      await run('repo.apply', { firstCommit: true }, ctx);
      expect(ctx.state.applied).toEqual(['label.create']);
    });
  });

  it('the count starts again at a new init document: a third call after one applies its labels, and a third call without one is still refused', async () => {
    const upgraded = { schema: 'kanon-init/v1', status: 'steps-left', inspection: { mergeQueue: 'no' }, findings: [finding('label.create'), finding('ruleset.require-check')] };
    const npx = stubExec([[(c) => c.cmd === 'npx', () => ({ status: 0, stdout: JSON.stringify(upgraded) })]]);
    for (const [verb, step] of [['kanon.init', { flags: ['--feature=full'] }], ['kanon.at', { release: RELEASE, command: 'init' }]]) {
      const g = stubGh(routes());
      const ctx = context({ gh: g.gh, exec: npx.exec, state: { ...kept(ALL), repoApply: 2 } });
      await run(verb, step, ctx);
      await run('repo.apply', {}, ctx);
      expect(g.writes().map((c) => [c.key, c.body])).toEqual([[`POST repos/${REPO}/labels`, { name: 'review:please' }], [`POST repos/${REPO}/labels`, { name: 'autorelease: pending' }]]);
      expect(ctx.state.repoApply).toBe(1);
    }
    const doctor = context({ exec: stubExec([[(c) => c.cmd === 'npx', () => ({ status: 4, stdout: JSON.stringify({ schema: 'kanon-doctor/v1', status: 'incomplete', exitCode: 4 }) })]]).exec, state: { ...kept([]), repoApply: 2 } });
    await run('kanon.doctor', { to: true }, doctor);
    await expect(run('repo.apply', {}, doctor)).rejects.toThrow(/third/);
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

  it('fills in {{release}} and {{repository}} in the scenario\'s files, as start/ takes them, and leaves a workflow\'s ${{ }} and a binary file as they are', async () => {
    const clone = tempDir('clone-');
    const dir = writeTree(tempDir('scenario-'), {
      'broken/.github/workflows/apps-check.yml': 'uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@{{release}}\nid: ${{ secrets.JUDGE_APP_ID }}\nin: {{repository}}\n',
      'broken/notes/{{release}}.md': 'x\n',
    });
    writeFileSync(join(dir, 'broken/blob.bin'), Buffer.from([0, 123, 123, 0x72, 125, 125]));
    const x = stubExec([[(c) => c.args.includes('ls-remote'), () => ({ status: 2 })]]);
    await run('files.commit', { from: 'scenario', dir: 'broken', branch: 'broken', message: 'm' }, context({ exec: x.exec, clone, scenarioDir: dir }));
    expect(readFileSync(join(clone, '.github/workflows/apps-check.yml'), 'utf8')).toBe(`uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@${RELEASE}\nid: \${{ secrets.JUDGE_APP_ID }}\nin: ${REPO}\n`);
    expect(existsSync(join(clone, `notes/${RELEASE}.md`))).toBe(true);
    expect([...readFileSync(join(clone, 'blob.bin'))]).toEqual([0, 123, 123, 0x72, 125, 125]);
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

  it('a git failure carries git\'s stderr, so the runner reads a transport error `infra` and a rejected push `fail`', async () => {
    const outcome = async (sub, r) => {
      const x = stubExec([[(c) => c.args.includes(sub), () => r]]);
      return classify(await run('files.commit', { delete: ['a'], branch: 'docs', message: 'm' }, context({ exec: x.exec, clone: tempDir() })).then(() => null, (e) => e));
    };
    const badGateway = { status: 128, stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502" };
    for (const sub of ['fetch', 'ls-remote', 'push']) expect(await outcome(sub, badGateway), sub).toBe('infra');
    expect(await outcome('push', { status: 1, stderr: ' ! [rejected]        HEAD -> docs (non-fast-forward)' })).toBe('fail');
  });

  it('a branch whose ls-remote fails is not taken for a new one: only `--exit-code`\'s 2 says it is missing', async () => {
    const x = stubExec([[(c) => c.args.includes('ls-remote'), () => ({ status: 128, stderr: 'fatal: Could not resolve host: github.com' })]]);
    await expect(run('files.commit', { delete: ['a'], branch: 'docs', message: 'm' }, context({ exec: x.exec, clone: tempDir() }))).rejects.toThrow(/git ls-remote exited 128/);
    expect(git(x)).not.toContain('checkout -q -B docs origin/main');
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
  // The pull request's merge-queue state, as GraphQL answers it: whether a queue sets its base's
  // strategy, whether it is in the queue, and the queue's last removal of it.
  const queueState = ({ enabled = false, queued = false, removals = [] } = {}) => ({
    data: { repository: { pullRequest: {
      id: 'PR_node5', headRefOid: 'abc1234', isMergeQueueEnabled: enabled, isInMergeQueue: queued,
      timelineItems: { nodes: removals.map(([createdAt, reason]) => ({ createdAt, reason })) },
    } } },
  });
  /** The GraphQL route: the read answers in turn, and the enqueue answers once. */
  const graphql = (...reads) => {
    const read = inTurn(...reads);
    return { 'POST graphql': (call) => (/enqueuePullRequest/.test(call.body.query) ? { data: { enqueuePullRequest: { mergeQueueEntry: { position: 1 } } } } : read()) };
  };
  const enqueues = (g) => g.calls.filter((c) => c.key === 'POST graphql' && /enqueuePullRequest/.test(c.body.query));

  it('through the front door: squash with auto-merge, then polls until merged', async () => {
    const g = stubGh({ ...graphql(queueState()), [`pr merge 5 -R ${REPO} --squash --auto`]: undefined, ...pulls({ state: 'open', merged: false }, { state: 'closed', merged: true }) });
    const ctx = context({ gh: g.gh, state: { prs: { docs: 5 } } });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, ctx);
    expect(ctx.clock.sleeps).toEqual([2000]);
  });

  it('merges at once where the pull request is already clean', async () => {
    const g = stubGh({
      ...graphql(queueState()),
      [`pr merge 5 -R ${REPO} --squash --auto`]: fail('Pull request is in clean status'),
      [`pr merge 5 -R ${REPO} --squash`]: undefined,
      ...pulls({ state: 'closed', merged: true }),
    });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
    expect(g.calls.map((c) => c.key)).toContain(`pr merge 5 -R ${REPO} --squash`);
  });

  it('merges at once where the repository doesn\'t allow auto-merge, as `kanon init` leaves a fresh one', async () => {
    const g = stubGh({
      ...graphql(queueState()),
      [`pr merge 5 -R ${REPO} --squash --auto`]: fail('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)'),
      [`pr merge 5 -R ${REPO} --squash`]: undefined,
      ...pulls({ state: 'closed', merged: true }),
    });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
    expect(g.calls.map((c) => c.key)).toEqual(['POST graphql', `pr merge 5 -R ${REPO} --squash --auto`, `pr merge 5 -R ${REPO} --squash`, `GET repos/${REPO}/pulls/5`]);
  });

  it('fails with GitHub\'s answer when the merge without auto-merge is refused too', async () => {
    const g = stubGh({
      ...graphql(queueState()),
      [`pr merge 5 -R ${REPO} --squash --auto`]: fail('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)'),
      [`pr merge 5 -R ${REPO} --squash`]: fail('Required status check "Lane check" is expected.'),
    });
    await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }))).rejects.toThrow(/Lane check/);
  });

  it('as the driver, where the ruleset lets a bypass actor through', async () => {
    const g = stubGh({ [`pr merge 5 -R ${REPO} --squash --admin`]: undefined, ...pulls({ state: 'closed', merged: true }) });
    await run('pr.merge', { pr: 'docs', via: 'bypass', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
    expect(g.calls[0].key).toBe(`pr merge 5 -R ${REPO} --squash --admin`);
  });

  it('fails when the pull request closes unmerged, or the deadline passes', async () => {
    const closed = stubGh({ ...graphql(queueState()), [`pr merge 5 -R ${REPO} --squash --auto`]: undefined, ...pulls({ state: 'closed', merged: false }) });
    await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: closed.gh, state: { prs: { docs: 5 } } }))).rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/closed without merging/) });
    const open = stubGh({ ...graphql(queueState()), [`pr merge 5 -R ${REPO} --squash --auto`]: undefined, ...pulls({ state: 'open', merged: false }) });
    await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 1 }, context({ gh: open.gh, state: { prs: { docs: 5 } } }))).rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/deadline/) });
  });

  // Where a merge queue sets the strategy, GitHub refuses `--squash`, and `--auto` too where the
  // repository doesn't allow auto-merge (#73). No `pr merge` is routed below, so a queued
  // repository sent down that path fails by name.
  it('through the front door where a merge queue sets the strategy: enqueues the head, then polls until merged', async () => {
    const g = stubGh({
      ...graphql(
        // The queue turned an earlier head away before this merge asked: that removal isn't this one's.
        queueState({ enabled: true, removals: [['2026-10-18T10:00:00Z', 'merge_conflict']] }),
      ),
      ...pulls({ state: 'open', merged: false }, { state: 'closed', merged: true }),
    });
    const ctx = context({ gh: g.gh, state: { prs: { docs: 5 } } });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, ctx);
    expect(enqueues(g).map((c) => c.body.variables)).toEqual([{ id: 'PR_node5', head: 'abc1234' }]);
    expect(g.calls.some((c) => c.key.startsWith('pr merge'))).toBe(false);
  });

  it('follows a pull request already in the merge queue, without enqueuing it again', async () => {
    const g = stubGh({ ...graphql(queueState({ enabled: true, queued: true })), ...pulls({ state: 'closed', merged: true }) });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }));
    expect(enqueues(g)).toEqual([]);
    expect(g.calls.some((c) => c.key.startsWith('pr merge'))).toBe(false);
  });

  it('fails with the queue\'s reason, before the deadline, when the queue removes the pull request unmerged', async () => {
    const g = stubGh({
      ...graphql(
        queueState({ enabled: true }),
        queueState({ enabled: true, queued: true }),
        queueState({ enabled: true, removals: [['2026-10-19T10:00:00Z', 'merge_conflict']] }),
      ),
      ...pulls({ state: 'open', merged: false }),
    });
    const ctx = context({ gh: g.gh, state: { prs: { docs: 5 } } });
    await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 60 }, ctx)).rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/merge queue removed pull request #5 without merging it \(merge_conflict\)/) });
    expect(ctx.clock.sleeps).toEqual([2000]);
  });

  // The queue read decides the path (#76): a read that fails, or answers without the queue's
  // state, fails the step, and never falls back to `--squash`, which a queued repository refuses
  // with GitHub's reason, hiding the cause (#73). `pr merge` is routed to succeed, so a fallback
  // would pass.
  describe('a merge-queue read that fails or answers malformed fails the step, and squashes nothing (#76)', () => {
    const merging = (read) => stubGh({
      'POST graphql': read,
      [`pr merge 5 -R ${REPO} --squash --auto`]: undefined,
      [`pr merge 5 -R ${REPO} --squash`]: undefined,
      ...pulls({ state: 'closed', merged: true }),
    });
    const merges = (g) => g.calls.filter((c) => c.key.startsWith('pr merge'));

    it('a read `gh` exits non-zero on fails the step with that error', async () => {
      const g = merging(fail('GraphQL: Something went wrong while executing your query. (HTTP 502)'));
      await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }))).rejects.toThrow(/gh api POST graphql exited 1: GraphQL: Something went wrong/);
      expect(merges(g)).toEqual([]);
    });

    it('a read with no pull request in it fails the step naming the missing merge-queue state', async () => {
      const g = merging({ data: { repository: { pullRequest: null } } });
      await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } }))).rejects.toThrow(/no merge-queue state for pull request #5/);
      expect(merges(g)).toEqual([]);
    });

    it('a read missing one queue field, or giving it the wrong type, fails the step too', async () => {
      const { isMergeQueueEnabled, ...noEnabled } = queueState().data.repository.pullRequest;
      expect(isMergeQueueEnabled).toBe(false);
      for (const pr of [noEnabled, { ...noEnabled, isMergeQueueEnabled: 'false' }, { ...queueState().data.repository.pullRequest, isInMergeQueue: null }, { ...queueState().data.repository.pullRequest, timelineItems: {} }]) {
        const g = merging({ data: { repository: { pullRequest: pr } } });
        await expect(run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: g.gh, state: { prs: { docs: 5 } } })), JSON.stringify(pr)).rejects.toThrow(/no merge-queue state for pull request #5/);
        expect(merges(g)).toEqual([]);
      }
    });
  });

  it('keeps polling when the queue\'s removal is its merge, which GitHub records as `merged`', async () => {
    const g = stubGh({
      ...graphql(queueState({ enabled: true }), queueState({ enabled: true, removals: [['2026-10-19T10:00:00Z', 'merged']] })),
      ...pulls({ state: 'open', merged: false }, { state: 'closed', merged: true }),
    });
    const ctx = context({ gh: g.gh, state: { prs: { docs: 5 } } });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, ctx);
    expect(ctx.clock.sleeps).toEqual([2000]);
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
      'POST graphql': { data: { repository: { pullRequest: { id: 'PR_node12', headRefOid: 'abc1234', isMergeQueueEnabled: false, isInMergeQueue: false, timelineItems: { nodes: [] } } } } },
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

  describe('when the deadline passes with no Release (#115)', () => {
    const PUSH_RUNS = `GET repos/${REPO}/actions/runs?event=push&head_sha=92b3573&per_page=1`;
    const routes = (pushRuns) => stubGh({
      [`GET repos/${REPO}/pulls?state=open&per_page=100`]: [[{ number: 7, labels: [{ name: 'autorelease: pending' }] }]],
      'POST graphql': { data: { repository: { pullRequest: { id: 'PR_node7', headRefOid: 'abc1234', isMergeQueueEnabled: false, isInMergeQueue: false, timelineItems: { nodes: [] } } } } },
      [`pr merge 7 -R ${REPO} --squash --auto`]: undefined,
      [`GET repos/${REPO}/pulls/7`]: { state: 'closed', merged: true, merged_at: '2026-10-22T09:02:24Z', merge_commit_sha: '92b3573' },
      [`GET repos/${REPO}/releases?per_page=20`]: [],
      [PUSH_RUNS]: pushRuns,
    });

    it('reads `infra` when GitHub delivered no push run of any kind for the merge commit, naming the commit', async () => {
      const g = routes({ total_count: 0, workflow_runs: [] });
      const e = await run('release.cut', { deadline: 15 }, context({ gh: g.gh })).catch((x) => x);
      expect(classify(e)).toBe('infra');
      expect(e.message).toMatch(/deadline of 15 minutes passed.*no Release since #7 merged.*no push run was delivered for 92b3573/);
      expect(g.calls.filter((c) => c.key === PUSH_RUNS)).toHaveLength(1);
    });

    it('stays `fail` when a push run exists for the merge commit: a caller that ran and published nothing is a finding', async () => {
      const g = routes({ total_count: 1, workflow_runs: [{ id: 9, event: 'push', head_sha: '92b3573' }] });
      const e = await run('release.cut', { deadline: 15 }, context({ gh: g.gh })).catch((x) => x);
      expect(e).toMatchObject({ name: 'Fail', message: expect.stringMatching(/no Release since #7 merged$/) });
      expect(classify(e)).toBe('fail');
    });

    it('stays `fail` when the push runs can\'t be read', async () => {
      const g = routes(fail('gh: Server Error (HTTP 502)'));
      const e = await run('release.cut', { deadline: 15 }, context({ gh: g.gh })).catch((x) => x);
      expect(classify(e)).toBe('fail');
    });
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

  it('a candidate\'s run: cancels as a nightly does, and asks no person anything (decision 9, amended 2026-10-20)', async () => {
    const g = stubGh({ ...waiting, [JOBS]: inTurn(job('waiting'), job('completed', 'cancelled')), [`POST repos/${REPO}/actions/runs/77/cancel`]: {} });
    const ctx = context({ gh: g.gh, trigger: 'candidate' });
    await run('deployment.await-approval', { environment: 'production', deadline: 30 }, ctx);
    expect(g.writes().map((c) => c.key)).toEqual([`POST repos/${REPO}/actions/runs/77/cancel`]);
    expect(ctx.state.approvals.production.decision).toBe('cancelled');
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

describe('bootstrap.end', () => {
  const git = (x) => x.calls.filter((c) => c.cmd === 'git').map((c) => c.args.filter((a) => !a.startsWith('user.')).join(' '));
  /** The adoption record `kanon init` writes, its `## Bootstrap` line last (Kanon's cli/init.mjs). */
  const RECORD = [
    '# Adoption record', '', '## Choices', '', '- **Rulesets:** on this plan.', '',
    '```', '## Bootstrap', '`in bootstrap since 2023-01-01`', '```', '',
    '## Bootstrap', '', '`in bootstrap since 2023-11-01`', '',
  ].join('\n');
  /** The day the fake clock reads, 1_700_000_000_000 ms. */
  const TODAY = '2023-11-14';
  const RULES = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false, allowed_merge_methods: ['squash'] } },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'Lane check' }] } },
  ];
  const routes = (over = {}) => ({
    [`GET repos/${REPO}/rulesets?per_page=100`]: [[{ id: 7, name: 'Kanon: default branch' }]],
    [`GET repos/${REPO}/rulesets/7`]: { id: 7, name: 'Kanon: default branch', rules: RULES },
    [`PUT repos/${REPO}/rulesets/7`]: {},
    ...over,
  });

  it('record: writes `ended <today>` under ## Bootstrap in the adoption record, in place of `in bootstrap since`, and pushes it to the default branch (K-ADOPT-6, K-LAYOUT-10)', async () => {
    const clone = writeTree(tempDir('clone-'), { 'docs/qa/adoption.md': RECORD });
    const x = stubExec();
    const ctx = context({ exec: x.exec, clone });
    await run('bootstrap.end', { move: 'record' }, ctx);
    expect(readFileSync(join(clone, 'docs/qa/adoption.md'), 'utf8')).toBe(RECORD.replace('`in bootstrap since 2023-11-01`', `\`ended ${TODAY}\``));
    expect(git(x)).toEqual([
      'fetch -q origin',
      'checkout -q -B main origin/main',
      'add -- docs/qa/adoption.md',
      '-c -c commit -q -m End bootstrap: record the date in the adoption record',
      'push -q origin HEAD:refs/heads/main',
    ]);
    expect(x.calls.every((c) => c.cwd === clone)).toBe(true);
    expect(ctx.state.bootstrapEnded).toBe(TODAY);
  });

  it('record: fails by name where the record says nothing of bootstrap under ## Bootstrap, or already says it ended', async () => {
    for (const text of ['# Adoption record\n\n`in bootstrap since 2023-11-01`\n', '## Bootstrap\n\n`ended 2023-11-02`\n']) {
      const clone = writeTree(tempDir('clone-'), { 'docs/qa/adoption.md': text });
      const x = stubExec();
      await expect(run('bootstrap.end', { move: 'record' }, context({ exec: x.exec, clone }))).rejects.toThrow(/in bootstrap since/);
      expect(git(x).filter((c) => c.startsWith('push'))).toEqual([]);
    }
  });

  it('record: refuses an adoption record reached through a symlink, before writing a byte', async () => {
    const clone = tempDir('clone-');
    const outside = writeTree(tempDir('outside-'), { 'qa/adoption.md': RECORD });
    mkdirSync(join(clone, 'docs'));
    symlinkSync(join(outside, 'qa'), join(clone, 'docs/qa'));
    const x = stubExec();
    await expect(run('bootstrap.end', { move: 'record' }, context({ exec: x.exec, clone }))).rejects.toThrow(/symlink/);
    expect(readFileSync(join(outside, 'qa/adoption.md'), 'utf8')).toBe(RECORD);
    expect(git(x).filter((c) => c.startsWith('push'))).toEqual([]);
  });

  it('approval: requires one approving review in the ruleset, dismissed when a new commit is pushed (K-MERGE-6), its other rules sent as they are', async () => {
    const g = stubGh(routes());
    const ctx = context({ gh: g.gh, state: { bootstrapEnded: TODAY } });
    await run('bootstrap.end', { move: 'approval' }, ctx);
    const [pr] = RULES.filter((r) => r.type === 'pull_request');
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([[`PUT repos/${REPO}/rulesets/7`, {
      rules: RULES.map((r) => (r === pr ? { ...pr, parameters: { ...pr.parameters, required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } } : r)),
    }]]);
    expect(ctx.state.bootstrapApproval).toBe(true);
  });

  it('approval: refuses before the record says bootstrap ended, without a ruleset, and without a pull request rule', async () => {
    await expect(run('bootstrap.end', { move: 'approval' }, context({ gh: stubGh(routes()).gh }))).rejects.toThrow(/`record`/);
    const none = stubGh(routes({ [`GET repos/${REPO}/rulesets?per_page=100`]: [[]] }));
    await expect(run('bootstrap.end', { move: 'approval' }, context({ gh: none.gh, state: { bootstrapEnded: TODAY } }))).rejects.toThrow(/Kanon: default branch/);
    const noRule = stubGh(routes({ [`GET repos/${REPO}/rulesets/7`]: { id: 7, rules: [{ type: 'deletion' }] } }));
    await expect(run('bootstrap.end', { move: 'approval' }, context({ gh: noRule.gh, state: { bootstrapEnded: TODAY } }))).rejects.toThrow(/pull request rule/);
    expect([...none.writes(), ...noRule.writes()]).toEqual([]);
  });

  it('runs each move once', async () => {
    await expect(run('bootstrap.end', { move: 'record' }, context({ state: { bootstrapEnded: TODAY } }))).rejects.toThrow(/once/);
    await expect(run('bootstrap.end', { move: 'approval' }, context({ state: { bootstrapEnded: TODAY, bootstrapApproval: true } }))).rejects.toThrow(/once/);
  });
});

describe('a write the runner asks again after GitHub\'s failure is looked up first (#130, the Owner 2026-10-25)', () => {
  /** `routes`, each write in `keys` answering a 502 the first time, then its route; `gh` retried as the runner retries it. */
  const flaky = (routes, ...keys) => {
    const asked = new Map();
    const wrapped = Object.fromEntries(keys.map((key) => [key, (c) => {
      asked.set(key, (asked.get(key) ?? 0) + 1);
      const then = routes[key];
      return asked.get(key) === 1 ? fail('gh: HTTP 502: Bad Gateway') : typeof then === 'function' ? then(c) : then;
    }]));
    const g = stubGh({ ...routes, ...wrapped });
    const count = (key) => g.calls.filter((c) => c.key === key).length;
    return { ...g, count, ctx: (over = {}) => context({ gh: retrying(g.gh, { sleep: async () => {} }), ...over }) };
  };
  const BAD = 'gh: HTTP 502: Bad Gateway';

  describe('pr.open: the open pull request for that head', () => {
    const POST = `POST repos/${REPO}/pulls`;
    const LOOKUP = `GET repos/${REPO}/pulls?state=open&head=${encodeURIComponent('kanon-e2e:docs')}&base=main&per_page=100`;
    it('landed: keeps the pull request the first POST made, and asks no second', async () => {
      const g = flaky({ [POST]: fail('HTTP 422: A pull request already exists for kanon-e2e:docs.'), [LOOKUP]: [{ number: 12 }] }, POST);
      const ctx = g.ctx();
      await run('pr.open', { name: 'docs', head: 'docs', title: 't' }, ctx);
      expect(ctx.state.prs).toEqual({ docs: 12 });
      expect(g.count(POST)).toBe(1);
    });
    it('not landed: asks again, and keeps what that answers', async () => {
      const g = flaky({ [POST]: { number: 5 }, [LOOKUP]: [] }, POST);
      const ctx = g.ctx();
      await run('pr.open', { name: 'docs', head: 'docs', title: 't' }, ctx);
      expect(ctx.state.prs).toEqual({ docs: 5 });
      expect(g.count(POST)).toBe(2);
      expect(g.count(LOOKUP)).toBe(1);
    });
  });

  describe('issue.open: the issue with that title and body, which no earlier step keeps', () => {
    const POST = `POST repos/${REPO}/issues`;
    const LOOKUP = `GET repos/${REPO}/issues?state=open&sort=created&direction=desc&per_page=100`;
    it('landed: keeps the issue the first POST made, never a pull request, another body or an issue an earlier step keeps', async () => {
      const open = [
        { number: 11, title: 'A bug', body: 'Steps.', pull_request: {} },
        { number: 10, title: 'A bug', body: 'Other steps.' },
        { number: 9, title: 'A bug', body: 'Steps.' },
        { number: 3, title: 'A bug', body: 'Steps.' },
      ];
      const g = flaky({ [POST]: { number: 99 }, [LOOKUP]: open }, POST);
      const ctx = g.ctx({ state: { issues: { first: 3 } } });
      await run('issue.open', { name: 'bug', title: 'A bug', body: 'Steps.' }, ctx);
      expect(ctx.state.issues).toEqual({ first: 3, bug: 9 });
      expect(g.count(POST)).toBe(1);
    });
    it('an empty body matches the null GitHub answers for it', async () => {
      const g = flaky({ [POST]: { number: 99 }, [LOOKUP]: [{ number: 9, title: 'A bug', body: null }] }, POST);
      const ctx = g.ctx();
      await run('issue.open', { name: 'bug', title: 'A bug' }, ctx);
      expect(ctx.state.issues).toEqual({ bug: 9 });
    });
    it('not landed: asks again', async () => {
      const g = flaky({ [POST]: { number: 99 }, [LOOKUP]: [{ number: 3, title: 'A bug', body: 'Steps.' }] }, POST);
      const ctx = g.ctx({ state: { issues: { first: 3 } } });
      await run('issue.open', { name: 'bug', title: 'A bug', body: 'Steps.' }, ctx);
      expect(ctx.state.issues.bug).toBe(99);
      expect(g.count(POST)).toBe(2);
    });
  });

  it('issue.label and pr.label: the labels on the issue, added or removed', async () => {
    const ADD = `POST repos/${REPO}/issues/9/labels`;
    const LABELS = `GET repos/${REPO}/issues/9/labels?per_page=100`;
    const g = flaky({ [ADD]: [], [LABELS]: [{ name: 'sev:low' }] }, ADD);
    await run('issue.label', { issue: 'bug', add: ['sev:low'] }, g.ctx({ state: { issues: { bug: 9 } } }));
    expect(g.count(ADD)).toBe(1);
    const missing = flaky({ [ADD]: [], [LABELS]: [] }, ADD);
    await run('issue.label', { issue: 'bug', add: ['sev:low'] }, missing.ctx({ state: { issues: { bug: 9 } } }));
    expect(missing.count(ADD)).toBe(2);

    const PADD = `POST repos/${REPO}/issues/5/labels`;
    const DEL = `DELETE repos/${REPO}/issues/5/labels/needs%3Ahuman`;
    const PLABELS = `GET repos/${REPO}/issues/5/labels?per_page=100`;
    const p = flaky({ [PADD]: [], [DEL]: fail('HTTP 404: Label does not exist'), [PLABELS]: [{ name: 'review:please' }] }, PADD, DEL);
    await run('pr.label', { pr: 'docs', add: ['review:please'], remove: ['needs:human'] }, p.ctx({ state: { prs: { docs: 5 } } }));
    expect([p.count(PADD), p.count(DEL)]).toEqual([1, 1]);
  });

  it('repo.apply: the label, the milestone and the ruleset', async () => {
    const LABEL = `POST repos/${REPO}/labels`;
    const MILESTONE = `POST repos/${REPO}/milestones`;
    const RULESET = `POST repos/${REPO}/rulesets`;
    const finding = (id) => ({ id, category: id.split('.')[0], blocking: false, subject: REPO, message: 'm', fix: { text: 't', commands: [], url: null } });
    const g = flaky({
      [`GET repos/yedeya-labs/kanon/contents/requirements.json?ref=${RELEASE}`]: { encoding: 'base64', content: b64({ labels: ['review:please'] }) },
      [`GET repos/${REPO}/labels?per_page=100`]: [[]],
      [`GET repos/${REPO}/labels/${encodeURIComponent('review:please')}`]: { name: 'review:please' },
      [LABEL]: fail('HTTP 422: already_exists'),
      [`GET repos/${REPO}/milestones?state=all&per_page=100`]: inTurn([[{ title: 'Product Backlog' }]], [[{ title: 'Product Backlog' }, { title: 'Development Automation' }]]),
      [MILESTONE]: fail('HTTP 422: already_exists'),
      [`GET repos/${REPO}/rulesets?per_page=100`]: inTurn([[]], [[{ id: 7, name: 'Kanon: default branch' }]]),
      [RULESET]: fail('HTTP 422: Name must be unique'),
    }, LABEL, MILESTONE, RULESET);
    const ids = ['label.create', 'milestone.buckets', 'ruleset.create'];
    await run('repo.apply', {}, g.ctx({ state: { documents: { init: { release: RELEASE, exit: 0, document: { schema: 'kanon-init/v1', status: 'steps-left', inspection: { mergeQueue: 'no' }, findings: ids.map(finding) } } } } }));
    expect([g.count(LABEL), g.count(MILESTONE), g.count(RULESET)]).toEqual([1, 1, 1]);
    expect(g.calls.filter((c) => c.key === MILESTONE).map((c) => c.body)).toEqual([{ title: 'Development Automation' }]);
  });

  it('ruleset.tags: the ruleset by its name', async () => {
    const POST = `POST repos/${REPO}/rulesets`;
    const g = flaky({ [`GET repos/${REPO}/rulesets?per_page=100`]: inTurn([[]], [[{ id: 8, name: 'Release tags' }]]), [POST]: fail('HTTP 422: Name must be unique') }, POST);
    await run('ruleset.tags', { pattern: 'v*.*.*' }, g.ctx());
    expect(g.count(POST)).toBe(1);
  });

  it('environment.create: the tag rule', async () => {
    const POLICIES = `repos/${REPO}/environments/staging/deployment-branch-policies`;
    const POST = `POST ${POLICIES}`;
    const g = flaky({
      [`PUT repos/${REPO}/environments/staging`]: {},
      [`GET ${POLICIES}?per_page=100`]: inTurn({ branch_policies: [] }, { branch_policies: [{ id: 4, name: 'v*.*.*', type: 'tag' }] }),
      [POST]: fail('HTTP 303: already exists'),
    }, POST);
    await run('environment.create', { name: 'staging', tags: 'v*.*.*' }, g.ctx());
    expect(g.count(POST)).toBe(1);
  });

  it('pr.merge: the merge queue\'s entry, and the auto-merge `pr merge` turned on', async () => {
    const queue = (queued) => ({ data: { repository: { pullRequest: { id: 'PR_node5', headRefOid: 'abc1234', isMergeQueueEnabled: true, isInMergeQueue: queued, timelineItems: { nodes: [] } } } } });
    let enqueued = 0;
    const read = inTurn(queue(false), queue(true));
    const q = stubGh({
      'POST graphql': (c) => (/enqueuePullRequest/.test(c.body.query) ? (++enqueued === 1 ? fail(BAD) : fail('HTTP 422: already queued')) : read()),
      [`GET repos/${REPO}/pulls/5`]: { state: 'closed', merged: true },
    });
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, context({ gh: retrying(q.gh, { sleep: async () => {} }), state: { prs: { docs: 5 } } }));
    expect(enqueued).toBe(1);

    const AUTO = `pr merge 5 -R ${REPO} --squash --auto`;
    const plain = (queued) => ({ data: { repository: { pullRequest: { ...queue(queued).data.repository.pullRequest, isMergeQueueEnabled: false } } } });
    const g = flaky({
      'POST graphql': plain(false),
      [AUTO]: fail('auto-merge is already enabled'),
      [`GET repos/${REPO}/pulls/5`]: inTurn({ state: 'open', merged: false, auto_merge: { merge_method: 'squash' } }, { state: 'closed', merged: true }),
    }, AUTO);
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, g.ctx({ state: { prs: { docs: 5 } } }));
    expect(g.count(AUTO)).toBe(1);
    const off = flaky({ 'POST graphql': plain(false), [AUTO]: undefined, [`GET repos/${REPO}/pulls/5`]: inTurn({ state: 'open', merged: false, auto_merge: null }, { state: 'closed', merged: true }) }, AUTO);
    await run('pr.merge', { pr: 'docs', via: 'front-door', deadline: 5 }, off.ctx({ state: { prs: { docs: 5 } } }));
    expect(off.count(AUTO)).toBe(2);
  });

  it('a write with no reliable lookup is asked once, and reads `infra`: workflow.dispatch', async () => {
    const POST = `POST repos/${REPO}/actions/workflows/apps-check.yml/dispatches`;
    const g = flaky({ [POST]: undefined }, POST);
    const e = await run('workflow.dispatch', { workflow: 'apps-check.yml' }, g.ctx()).catch((x) => x);
    expect(classify(e)).toBe('infra');
    expect(g.count(POST)).toBe(1);
  });
});
