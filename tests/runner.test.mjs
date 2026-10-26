import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exec as realExec } from '../runner/lib/proc.mjs';
import { api } from '../runner/lib/gh.mjs';
import { classify, isRetryable, isWrite, retrying, retryingExec } from '../runner/lib/retry.mjs';
import { readState, runSegment } from '../runner/run.mjs';
import { RELEASE, fail, fakeClock, inTurn, scenarioJson, stubGh, tempDir, writeScenario } from './helpers/stubs.mjs';

/**
 * The runner (Kanon plan 0012 §5.1, §5.2, §10; harness #16), one segment at a time, on a stubbed
 * `gh`, a stubbed `npx` and a real `git` against a local bare repository standing in for the
 * scenario repository. It classifies the scenario `pass`, `fail` or `infra`, and the `act` job
 * that learns the result deletes the repository, or keeps a failed one archived with the
 * `kanon-e2e-failed` topic for 24 hours (decision 13).
 */

const OWNER = 'kanon-e2e';
const NAME = 'e2e-sample-123-1';
const REPOSITORY = `${OWNER}/${NAME}`;
const RUN = { id: '123', attempt: '1', url: 'https://github.com/kanon-e2e/harness/actions/runs/123' };
const PROVISIONED = ['kanon-e2e', 'kanon-e2e-provisioned'];

/** A bare repository, empty, as `provision` leaves the scenario repository. */
const bareRemote = () => {
  const dir = join(tempDir('remote-'), 'repo.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  return dir;
};
/** The files on the remote's `main`, by path, or {} when it has no commit. */
const remoteFiles = (remote) => {
  let list;
  try {
    list = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim();
  } catch {
    return {};
  }
  return Object.fromEntries(list.split('\n').filter(Boolean).map((p) => [p, execFileSync('git', ['--git-dir', remote, 'show', `main:${p}`], { encoding: 'utf8' })]));
};
const commits = (remote) => {
  try {
    return execFileSync('git', ['--git-dir', remote, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim().split('\n');
  } catch {
    return [];
  }
};

/** `gh` routes for the scenario repository, as `provision` left it. */
const repoRoutes = ({ topics = PROVISIONED, secrets = [], gone = false } = {}) => ({
  [`GET repos/${REPOSITORY}`]: gone ? fail('HTTP 404: Not Found') : { full_name: REPOSITORY, default_branch: 'main', topics, archived: false },
  [`GET repos/${REPOSITORY}/actions/secrets?per_page=100`]: { total_count: secrets.length, secrets: secrets.map((name) => ({ name })) },
  [`DELETE repos/${REPOSITORY}`]: undefined,
  [`PUT repos/${REPOSITORY}/topics`]: (c) => ({ names: c.body.names }),
  [`PATCH repos/${REPOSITORY}`]: {},
});

const VARS = `GET repos/${REPOSITORY}/actions/variables`;
const expectVars = (n = 1, deadline = 1) => ({ verb: 'expect.api', path: 'repos/{{repository}}/actions/variables', pointer: '/total_count', equals: n, deadline });

/** Runs one segment with everything outside stubbed but git. */
const segment = async ({ segment: kind = 'act', phase = 1, steps, scenario, state, stateProblem, routes = {}, gh, npx, git, artifactDir, remote = bareRemote(), start } = {}) => {
  const dir = writeScenario({ scenario: scenario ?? scenarioJson('sample'), steps: steps ?? { phases: [{ kanon: [], act: [expectVars()] }] }, ...(start ? { start } : {}) });
  const g = gh ?? stubGh({ ...repoRoutes(), ...routes });
  const clock = fakeClock();
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    if (cmd === 'npx') return npx ? npx(args, opts) : { status: 1, stdout: '', stderr: 'npx is stubbed' };
    // `git`'s answer from the test's stub, when it gives one; the real git's otherwise.
    const stubbed = cmd === 'git' && git ? git(args, opts) : undefined;
    return stubbed ?? realExec(cmd, args, opts);
  };
  const work = tempDir('work-');
  const out = await runSegment({
    segment: kind, phase, scenarioDir: dir, repository: REPOSITORY, release: RELEASE, trigger: 'nightly', harness: 'kanon-e2e/harness',
    run: RUN, state: state === undefined ? null : state, stateProblem, artifactDir, work, remote,
  }, { gh: g.gh, exec, now: clock.now, sleep: clock.sleep, log: () => {} });
  return { ...out, g, calls, remote, work, clock };
};

/** The state a `kanon` job hands its `act` job, before any result. */
const kanonState = (over = {}) => ({
  schema: 'kanon-e2e-state/v1', scenario: 'sample', repository: REPOSITORY, release: RELEASE, startedAt: fakeClock().now(),
  laid: false, ref: null, steps: [], result: null, firstFailure: null, finalized: false, ...over,
});

describe('a passing scenario deletes its repository (§5.1 step 7)', () => {
  it('lays start/ as the first commit, runs the steps, reads pass, and deletes the repository', async () => {
    const { result, state, g, remote } = await segment({ state: kanonState(), routes: { [VARS]: { total_count: 1 } } });
    expect(result).toMatchObject({ schema: 'kanon-e2e-result/v1', scenario: 'sample', release: RELEASE, result: 'pass', repository: REPOSITORY, firstFailure: null, repositoryAction: 'deleted' });
    expect(result.steps).toEqual([expect.objectContaining({ phase: 1, segment: 'act', verb: 'expect.api', outcome: 'pass', durationMs: expect.any(Number) })]);
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([
      [`PUT repos/${REPOSITORY}/topics`, { names: ['kanon-e2e', 'kanon-e2e-provisioned', 'kanon-e2e-passed'] }],
      [`DELETE repos/${REPOSITORY}`, undefined],
    ]);
    expect(state).toMatchObject({ result: 'pass', finalized: true, laid: true });
    expect(commits(remote)).toEqual(['Lay the scenario\'s starting tree']);
    expect(remoteFiles(remote)).toEqual({ 'README.md': `Pinned to ${RELEASE} in ${REPOSITORY}.\n` });
  });

  it('reads pass only after the scenario\'s last phase', async () => {
    const steps = { phases: [{ kanon: [], act: [expectVars()] }, { kanon: [], act: [expectVars()] }] };
    const first = await segment({ steps, state: kanonState(), routes: { [VARS]: { total_count: 1 } } });
    expect(first.result).toBeNull();
    expect(first.state).toMatchObject({ result: null, finalized: false, laid: true, ref: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(first.g.writes()).toEqual([]);
  });

  it('a later `kanon` job after the result passes the state through and calls nothing', async () => {
    const done = kanonState({ result: 'fail', finalized: true, laid: true });
    const g = stubGh({});
    const { state, result } = await segment({ segment: 'kanon', phase: 2, state: done, gh: g });
    expect(result).toBeNull();
    expect(state).toEqual(done);
    expect(g.calls).toEqual([]);
  });
});

describe('a failing scenario keeps its repository 24 hours, archived, with the `kanon-e2e-failed` topic (decision 13)', () => {
  it('marks it with the topic, then archives it, and never deletes it', async () => {
    const { result, g } = await segment({ state: kanonState(), routes: { [VARS]: { total_count: 0 } } });
    expect(result).toMatchObject({ result: 'fail', repositoryAction: 'kept' });
    expect(result.firstFailure).toMatchObject({ phase: 1, segment: 'act', index: 0, verb: 'expect.api', message: expect.stringMatching(/deadline of 1 minute.*total_count/) });
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([
      [`PUT repos/${REPOSITORY}/topics`, { names: ['kanon-e2e', 'kanon-e2e-provisioned', 'kanon-e2e-failed'] }],
      [`PATCH repos/${REPOSITORY}`, { archived: true }],
    ]);
  });

  it('a step that fails stops the scenario: no later step runs', async () => {
    const steps = { phases: [{ kanon: [], act: [expectVars(0), expectVars(1)] }] };
    const { result } = await segment({ steps, state: kanonState(), routes: { [VARS]: { total_count: 1 } } });
    expect(result.steps.map((s) => s.outcome)).toEqual(['fail', 'skipped']);
  });
});

describe('a 502 is retried; a false expectation is not (§10)', () => {
  it('retries a 502 on the same call, and the scenario passes', async () => {
    const { result, g } = await segment({ state: kanonState(), routes: { [VARS]: inTurn(fail('HTTP 502: Bad Gateway (https://api.github.com/…)'), { total_count: 1 }) } });
    expect(result.result).toBe('pass');
    expect(g.calls.filter((c) => c.key === VARS)).toHaveLength(2);
  });

  it('never runs a false expectation again: one poll to its deadline, then fail', async () => {
    const { result, g } = await segment({ state: kanonState(), routes: { [VARS]: { total_count: 0 } } });
    expect(result.result).toBe('fail');
    // One poll of a 1-minute deadline asks at 0, 2, 6, 14, 30 and 60 seconds: six GETs, no more.
    expect(g.calls.filter((c) => c.key === VARS)).toHaveLength(6);
  });

  it('isRetryable: a 5xx, a rate limit and a network error; never a 404, a 422 or a false expectation', () => {
    for (const stderr of ['HTTP 502: Bad Gateway', 'HTTP 503', 'gh: HTTP 500: Internal Server Error', 'API rate limit exceeded for installation', 'You have exceeded a secondary rate limit', 'read: connection reset by peer', 'dial tcp: lookup api.github.com: i/o timeout', 'unexpected end of JSON input']) {
      expect(isRetryable({ status: 1, stderr }), stderr).toBe(true);
    }
    for (const stderr of ['HTTP 404: Not Found', 'HTTP 422: Validation Failed', 'HTTP 401: Bad credentials']) expect(isRetryable({ status: 1, stderr }), stderr).toBe(false);
    expect(isRetryable({ status: 0, stderr: 'HTTP 502' })).toBe(false);
  });

  it('a body GitHub cut off, `gh`\'s "unexpected end of JSON input", is retried three times, then reads `infra`', async () => {
    const { result, g } = await segment({ state: kanonState(), routes: { [VARS]: fail('unexpected end of JSON input') } });
    expect(result).toMatchObject({ result: 'infra', repositoryAction: 'deleted' });
    expect(result.firstFailure.message).toMatch(/exited 1: unexpected end of JSON input/);
    expect(g.calls.filter((c) => c.key === VARS)).toHaveLength(4);
  });

  it('retrying(): up to three retries per call, backing off, then gives the failure back', async () => {
    const clock = fakeClock();
    let n = 0;
    const gh = retrying(async () => { n++; return { status: 1, stdout: '', stderr: 'HTTP 502' }; }, { sleep: clock.sleep });
    expect((await gh(['api', 'x'])).status).toBe(1);
    expect(n).toBe(4);
    expect(clock.sleeps).toEqual([2000, 4000, 8000]);
  });
});

describe('a write is looked up before it is asked again (#130, the Owner 2026-10-25)', () => {
  const BAD = { status: 1, stdout: '', stderr: 'gh: HTTP 502: Bad Gateway' };
  const OK = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
  /** A `gh` that answers each call in turn from `answers`, the last repeated, recording what it was asked. */
  const scripted = (...answers) => {
    const seen = [];
    const gh = async (args) => { seen.push(args.join(' ')); return answers[Math.min(seen.length - 1, answers.length - 1)]; };
    return { gh, seen };
  };
  const POST = ['api', '-X', 'POST', 'repos/o/r/pulls', '--input', '-'];

  it('isWrite(): a POST, a DELETE, a GraphQL mutation and `pr merge` write; a GET, a PUT, a PATCH, a GraphQL query and `run download` do not', () => {
    expect(isWrite(POST, '{}')).toBe(true);
    expect(isWrite(['api', '-X', 'DELETE', 'repos/o/r'])).toBe(true);
    expect(isWrite(['api', '-X', 'POST', 'graphql', '--input', '-'], JSON.stringify({ query: 'mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' }))).toBe(true);
    expect(isWrite(['pr', 'merge', '5', '-R', 'o/r', '--squash', '--auto'])).toBe(true);
    expect(isWrite(['api', 'repos/o/r'])).toBe(false);
    expect(isWrite(['api', '--paginate', '--slurp', 'repos/o/r/labels?per_page=100'])).toBe(false);
    expect(isWrite(['api', '-X', 'PUT', 'repos/o/r/topics', '--input', '-'], '{}')).toBe(false);
    expect(isWrite(['api', '-X', 'PATCH', 'repos/o/r', '--input', '-'], '{}')).toBe(false);
    expect(isWrite(['api', '-X', 'POST', 'graphql', '--input', '-'], JSON.stringify({ query: 'query($n:Int!){repository(owner:"o",name:"r"){pullRequest(number:$n){id}}}' }))).toBe(false);
    expect(isWrite(['run', 'download', '7', '-R', 'o/r', '-n', 'x', '-D', '/tmp/x'])).toBe(false);
  });

  it('a write with no lookup is asked once: its 502 comes back as it is, and reads `infra`', async () => {
    const clock = fakeClock();
    const { gh, seen } = scripted(BAD, OK({ number: 5 }));
    const r = await retrying(gh, clock)(POST, '{}');
    expect(r).toEqual(BAD);
    expect(seen).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    expect(classify(Object.assign(new Error('x'), { stderr: r.stderr }))).toBe('infra');
  });

  // GitHub refused these before acting, or the request never reached it (#137, the Owner 2026-10-26).
  const RATE_LIMITED = { status: 1, stdout: '', stderr: 'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)' };
  const UNREACHED = [
    'Post "https://api.github.com/repos/o/r/actions/workflows/x.yml/dispatches": dial tcp 140.82.112.6:443: connect: connection refused',
    'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
    'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": dial tcp: lookup api.github.com: no such host',
    'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": dial tcp: lookup api.github.com on 127.0.0.53:53: Temporary failure in name resolution',
    'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": dial tcp [2606:50c0::1]:443: connect: network is unreachable',
    "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443: Connection timed out",
    "error: RPC failed; curl 7 Couldn't connect to server",
  ];

  it('a write with no lookup refused for a rate limit is asked once more, after a minute, and that answer is the call\'s (#137)', async () => {
    const clock = fakeClock();
    const { gh, seen } = scripted(RATE_LIMITED, OK({}));
    expect(await retrying(gh, clock)(POST, '{}')).toEqual(OK({}));
    expect(seen).toHaveLength(2);
    expect(clock.sleeps).toEqual([60_000]);
    const always = scripted(RATE_LIMITED);
    const slow = fakeClock();
    expect(await retrying(always.gh, slow)(POST, '{}')).toEqual(RATE_LIMITED);
    expect(always.seen).toHaveLength(2);
    expect(slow.sleeps).toEqual([60_000]);
  });

  it('a write with no lookup whose connection was never made is asked once more, after 2 seconds, and that answer is the call\'s (#137)', async () => {
    for (const stderr of UNREACHED) {
      const clock = fakeClock();
      const { gh, seen } = scripted({ status: 1, stdout: '', stderr }, OK({}));
      expect(await retrying(gh, clock)(POST, '{}'), stderr).toEqual(OK({}));
      expect(seen, stderr).toHaveLength(2);
      expect(clock.sleeps, stderr).toEqual([2000]);
      const refused = { status: 1, stdout: '', stderr };
      const always = scripted(refused);
      const twice = fakeClock();
      expect(await retrying(always.gh, twice)(POST, '{}'), stderr).toEqual(refused);
      expect(always.seen, stderr).toHaveLength(2);
      expect(twice.sleeps, stderr).toEqual([2000]);
    }
  });

  it('a write with no lookup that may have reached GitHub is still asked once: a 5xx, a reset, a timeout, an EOF, a cut-off answer, an unreachable network on a made connection (#137)', async () => {
    for (const stderr of [
      'gh: HTTP 502: Bad Gateway',
      'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": read tcp 10.1.0.4:5000->140.82.112.6:443: read: connection reset by peer',
      'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": read tcp 10.1.0.4:5000->140.82.112.6:443: i/o timeout',
      'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": net/http: TLS handshake timeout',
      'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": EOF',
      'unexpected end of JSON input',
      'Post "https://api.github.com/repos/o/r/actions/runs/7/cancel": write tcp 10.1.0.4:5000->140.82.112.6:443: write: network is unreachable',
    ]) {
      expect(isRetryable({ status: 1, stderr }), stderr).toBe(true);
      const { gh, seen } = scripted({ status: 1, stdout: '', stderr }, OK({}));
      expect((await retrying(gh, fakeClock())(POST, '{}')).stderr, stderr).toBe(stderr);
      expect(seen, stderr).toHaveLength(1);
    }
  });

  it('a write with no lookup stops at the first failure that may have reached GitHub, after a rate limit or a refused connection (#137)', async () => {
    for (const first of [RATE_LIMITED, { status: 1, stdout: '', stderr: UNREACHED[0] }]) {
      const { gh, seen } = scripted(first, BAD, OK({}));
      expect(await retrying(gh, fakeClock())(POST, '{}')).toEqual(BAD);
      expect(seen).toHaveLength(2);
    }
  });

  it('gh\'s own wording for a host it couldn\'t look up, "error connecting to", is a network error: retried, and `infra` (#137)', async () => {
    const stderr = UNREACHED[1];
    expect(isRetryable({ status: 1, stderr })).toBe(true);
    expect(classify(Object.assign(new Error('x'), { stderr }))).toBe('infra');
    const { gh, seen } = scripted({ status: 1, stdout: '', stderr });
    await retrying(gh, fakeClock())(['api', 'repos/o/r']);
    expect(seen).toHaveLength(4);
  });

  it('a write whose first attempt landed: looked up after the backoff, never asked again, and the lookup\'s answer is the call\'s', async () => {
    const clock = fakeClock();
    const { gh, seen } = scripted(BAD, OK({ number: 6 }));
    let looked = 0;
    const r = await retrying(gh, clock)(POST, '{}', { landed: async () => { looked++; return { answer: { number: 5 } }; } });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ number: 5 });
    expect(seen).toHaveLength(1);
    expect(clock.sleeps).toEqual([2000]);
    expect(looked).toBe(1);
  });

  it('a write that didn\'t land is asked again after each lookup that finds nothing, up to three times, then gives the failure back', async () => {
    const clock = fakeClock();
    const { gh, seen } = scripted(BAD);
    let looked = 0;
    const r = await retrying(gh, clock)(POST, '{}', { landed: async () => { looked++; return null; } });
    expect(r).toEqual(BAD);
    expect(seen).toHaveLength(4);
    expect(looked).toBe(3);
    expect(clock.sleeps).toEqual([2000, 4000, 8000]);
    const twice = scripted(BAD, OK({ number: 7 }));
    const r2 = await retrying(twice.gh, fakeClock())(POST, '{}', { landed: async () => null });
    expect(JSON.parse(r2.stdout)).toEqual({ number: 7 });
    expect(twice.seen).toHaveLength(2);
  });

  it('a lookup that finds an empty answer, such as a DELETE\'s, counts as landed', async () => {
    const { gh, seen } = scripted(BAD);
    const r = await retrying(gh, fakeClock())(['api', '-X', 'DELETE', 'repos/o/r'], undefined, { landed: async () => ({ answer: null }) });
    expect(r).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(seen).toHaveLength(1);
  });

  it('a write GitHub refused (a 422) is neither looked up nor asked again', async () => {
    const refused = { status: 1, stdout: '', stderr: 'gh: Validation Failed (HTTP 422)' };
    const { gh, seen } = scripted(refused);
    let looked = 0;
    expect(await retrying(gh, fakeClock())(POST, '{}', { landed: async () => { looked++; return null; } })).toEqual(refused);
    expect(seen).toHaveLength(1);
    expect(looked).toBe(0);
  });

  it('reads keep today\'s retries, and so do a PUT and a PATCH, which set a state that asking again leaves the same', async () => {
    for (const args of [['api', 'repos/o/r'], ['api', '-X', 'PUT', 'repos/o/r/topics', '--input', '-'], ['api', '-X', 'PATCH', 'repos/o/r', '--input', '-'], ['run', 'download', '7']]) {
      const { gh, seen } = scripted(BAD);
      await retrying(gh, fakeClock())(args, '{}');
      expect(seen, args.join(' ')).toHaveLength(4);
    }
  });

  it('api(): a write GitHub answered whole but cut off is looked up; with no lookup, or none found, it reads `infra`', async () => {
    const cut = { gh: async () => ({ status: 0, stdout: '{"number": 5, "ti', stderr: '' }), repository: 'o/r' };
    expect(await api(cut, 'repos/o/r/pulls', { method: 'POST', body: {}, landed: async () => ({ answer: { number: 5 } }) })).toEqual({ number: 5 });
    for (const landed of [undefined, async () => null]) {
      const e = await api(cut, 'repos/o/r/pulls', { method: 'POST', body: {}, landed }).catch((x) => x);
      expect(classify(e)).toBe('infra');
      expect(e.message).toMatch(/POST repos\/o\/r\/pulls.*cut off/);
    }
    // A read's cut-off answer is unchanged: the harness's own error.
    const read = await api(cut, 'repos/o/r/pulls/5').catch((x) => x);
    expect(classify(read)).toBe('fail');
  });

  it('api() hands a write\'s lookup to `gh`, which the runner retries with it', async () => {
    const seen = [];
    const landed = async () => null;
    await api({ gh: async (args, input, opts) => { seen.push(opts); return OK({}); }, repository: 'o/r' }, 'repos/o/r/labels', { method: 'POST', body: { name: 'x' }, landed });
    expect(seen).toEqual([{ landed }]);
  });

  it('in a segment: `pr.open`\'s POST that GitHub committed before its 502 keeps the pull request it made, and the scenario passes', async () => {
    const steps = { phases: [{ kanon: [], act: [{ verb: 'pr.open', name: 'docs', head: 'docs', title: 'docs: a line' }] }] };
    const PULLS = `POST repos/${REPOSITORY}/pulls`;
    const { result, state, g } = await segment({ steps, state: kanonState(), routes: {
      [PULLS]: inTurn(fail('HTTP 502: Bad Gateway'), fail('HTTP 422: A pull request already exists for kanon-e2e:docs.')),
      [`GET repos/${REPOSITORY}/pulls?state=open&head=${encodeURIComponent(`${OWNER}:docs`)}&base=main&per_page=100`]: [{ number: 12, head: { ref: 'docs' } }],
    } });
    expect(result.result).toBe('pass');
    expect(state.prs).toEqual({ docs: 12 });
    expect(g.calls.filter((c) => c.key === PULLS)).toHaveLength(1);
  });

  it('in a segment: the repository\'s DELETE that landed before its 502 reads `deleted`, asked once', async () => {
    let deleted = false;
    const { result, g } = await segment({ state: kanonState(), routes: {
      [VARS]: { total_count: 1 },
      [`DELETE repos/${REPOSITORY}`]: () => { deleted = true; return fail('HTTP 502: Bad Gateway'); },
      [`GET repos/${REPOSITORY}`]: () => (deleted ? fail('HTTP 404: Not Found') : { full_name: REPOSITORY, default_branch: 'main', topics: PROVISIONED, archived: false }),
    } });
    expect(result).toMatchObject({ result: 'pass', repositoryAction: 'deleted' });
    expect(g.calls.filter((c) => c.key === `DELETE repos/${REPOSITORY}`)).toHaveLength(1);
  });
});

describe('`git` to GitHub is retried as `gh` is; a transport error it outlasts is `infra` (§10)', () => {
  const BAD_GATEWAY = { status: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/kanon-e2e/e2e-sample-123-1.git/': The requested URL returned error: 502\n" };
  const REJECTED = { status: 1, stdout: '', stderr: " ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/kanon-e2e/e2e-sample-123-1.git'\n" };
  // What GitHub's git server answered the install burn-in's push with (harness #70): the push was
  // valid, and GitHub failed to write the ref.
  const COMMIT_REFS = { status: 1, stdout: '', stderr: "remote: fatal error in commit_refs        \nTo https://github.com/kanon-e2e/e2e-sample-123-1.git\n ! [remote rejected] HEAD -> main (failure)\nerror: failed to push some refs to 'https://github.com/kanon-e2e/e2e-sample-123-1.git'\n" };
  const RULESET = "remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Changes must be made through a pull request.\nTo https://github.com/kanon-e2e/e2e-sample-123-1.git\n ! [remote rejected] HEAD -> main (push declined due to repository rule violations)\nerror: failed to push some refs to 'https://github.com/kanon-e2e/e2e-sample-123-1.git'\n";
  const PROTECTED = "remote: error: GH006: Protected branch update failed for refs/heads/main.\nTo https://github.com/kanon-e2e/e2e-sample-123-1.git\n ! [remote rejected] HEAD -> main (protected branch hook declined)\nerror: failed to push some refs to 'https://github.com/kanon-e2e/e2e-sample-123-1.git'\n";
  const gitCalls = (calls, sub) => calls.filter((c) => c.cmd === 'git' && c.args[0] === sub);
  /** A `git` stub that answers `sub`'s calls in turn with `answers`, the last repeated: undefined runs the real git. */
  const failing = (sub, ...answers) => {
    let n = 0;
    return (args) => (args[0] === sub ? answers[Math.min(n++, answers.length - 1)] : undefined);
  };
  const commitStep = { verb: 'files.commit', delete: ['README.md'], message: 'Remove the README' };

  it('retries a clone that fails with a 502, and the scenario passes', async () => {
    for (const kind of ['act', 'kanon']) {
      const { state, calls, clock } = await segment({ segment: kind, state: kind === 'act' ? kanonState() : null, routes: { [VARS]: { total_count: 1 } }, git: failing('clone', BAD_GATEWAY, undefined) });
      expect(state.result, kind).toBe(kind === 'act' ? 'pass' : null);
      expect(gitCalls(calls, 'clone'), kind).toHaveLength(2);
      expect(clock.sleeps, kind).toEqual([2000]);
    }
  });

  it('a clone whose 502 outlasts the retries reads `infra`, not `fail`', async () => {
    for (const kind of ['act', 'kanon']) {
      const { state, calls } = await segment({ segment: kind, state: kind === 'act' ? kanonState() : null, routes: { [VARS]: { total_count: 1 } }, git: failing('clone', BAD_GATEWAY) });
      expect(state.result, kind).toBe('infra');
      expect(state.firstFailure.message, kind).toMatch(/git clone exited 128: .*returned error: 502/);
      expect(gitCalls(calls, 'clone'), kind).toHaveLength(4);
    }
  });

  it('the push that lays start/, failing with a 502 the retries outlast, reads `infra`, and the repository is deleted', async () => {
    const { result, calls, remote } = await segment({ state: kanonState(), routes: { [VARS]: { total_count: 1 } }, git: failing('push', BAD_GATEWAY) });
    expect(result).toMatchObject({ result: 'infra', repositoryAction: 'deleted' });
    expect(result.firstFailure.message).toMatch(/git push exited 128: .*returned error: 502/);
    expect(gitCalls(calls, 'push')).toHaveLength(4);
    expect(commits(remote)).toEqual([]);
  });

  it('`files.commit`\'s push, failing with a 502 the retries outlast, reads `infra`; one that comes back is retried and passes', async () => {
    const steps = { phases: [{ kanon: [], act: [commitStep] }] };
    // The first push lays start/; the step's is the second.
    const outlasted = await segment({ steps, state: kanonState(), git: failing('push', undefined, BAD_GATEWAY) });
    expect(outlasted.result).toMatchObject({ result: 'infra', repositoryAction: 'deleted', firstFailure: expect.objectContaining({ verb: 'files.commit', message: expect.stringMatching(/git push exited 128: .*returned error: 502/) }) });
    expect(outlasted.result.steps).toEqual([expect.objectContaining({ verb: 'files.commit', outcome: 'infra' })]);
    expect(gitCalls(outlasted.calls, 'push')).toHaveLength(5);
    const recovered = await segment({ steps, state: kanonState(), git: failing('push', undefined, BAD_GATEWAY, undefined) });
    expect(recovered.result.result).toBe('pass');
    expect(commits(recovered.remote)).toEqual(['Remove the README', 'Lay the scenario\'s starting tree']);
  });

  it('`files.commit`\'s fetch, failing with a host that won\'t resolve, reads `infra`', async () => {
    const steps = { phases: [{ kanon: [], act: [commitStep] }] };
    const unresolved = { status: 128, stdout: '', stderr: "fatal: unable to access 'https://github.com/kanon-e2e/e2e-sample-123-1.git/': Could not resolve host: github.com\n" };
    const { result, calls } = await segment({ steps, state: kanonState(), git: failing('fetch', unresolved) });
    expect(result).toMatchObject({ result: 'infra', firstFailure: expect.objectContaining({ verb: 'files.commit' }) });
    expect(gitCalls(calls, 'fetch')).toHaveLength(4);
  });

  it('a push GitHub rejects is not transport: asked once, and it reads `fail` as before', async () => {
    const steps = { phases: [{ kanon: [], act: [commitStep] }] };
    const { result, calls } = await segment({ steps, state: kanonState(), git: failing('push', undefined, REJECTED) });
    expect(result).toMatchObject({ result: 'fail', repositoryAction: 'kept', firstFailure: expect.objectContaining({ verb: 'files.commit', message: expect.stringMatching(/rejected/) }) });
    expect(gitCalls(calls, 'push')).toHaveLength(2);
  });

  it('a push GitHub failed to write, `remote: fatal error in commit_refs`, is retried three times, then reads `infra`', async () => {
    const steps = { phases: [{ kanon: [], act: [commitStep] }] };
    const { result, calls } = await segment({ steps, state: kanonState(), git: failing('push', undefined, COMMIT_REFS) });
    expect(result).toMatchObject({ result: 'infra', repositoryAction: 'deleted', firstFailure: expect.objectContaining({ verb: 'files.commit', message: expect.stringMatching(/fatal error in commit_refs/) }) });
    expect(gitCalls(calls, 'push')).toHaveLength(5);
  });

  it('`[remote rejected] … (failure)` alone is GitHub\'s failure too: retried three times, then `infra`', async () => {
    const steps = { phases: [{ kanon: [], act: [commitStep] }] };
    const failure = { status: 1, stdout: '', stderr: " ! [remote rejected] HEAD -> main (failure)\nerror: failed to push some refs to 'https://github.com/kanon-e2e/e2e-sample-123-1.git'\n" };
    const { result, calls } = await segment({ steps, state: kanonState(), git: failing('push', undefined, failure) });
    expect(result).toMatchObject({ result: 'infra', firstFailure: expect.objectContaining({ verb: 'files.commit' }) });
    expect(gitCalls(calls, 'push')).toHaveLength(5);
  });

  it('a push a ruleset refuses is not GitHub\'s failure: asked once, and it reads `fail`', async () => {
    const steps = { phases: [{ kanon: [], act: [commitStep] }] };
    for (const stderr of [RULESET, PROTECTED]) {
      const { result, calls } = await segment({ steps, state: kanonState(), git: failing('push', undefined, { status: 1, stdout: '', stderr }) });
      expect(result, stderr).toMatchObject({ result: 'fail', repositoryAction: 'kept', firstFailure: expect.objectContaining({ verb: 'files.commit' }) });
      expect(gitCalls(calls, 'push'), stderr).toHaveLength(2);
    }
  });

  it('isRetryable: git\'s and curl\'s wording for a 5xx and a network failure; never a rejected push, a 4xx or a refused path', () => {
    for (const stderr of [
      BAD_GATEWAY.stderr,
      'error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503',
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 130 ms: Couldn't connect to server",
      'error: RPC failed; curl 56 GnuTLS recv error (-54): Error in the pull function.',
      'error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)',
      'fatal: early EOF',
      COMMIT_REFS.stderr,
      'remote: fatal error in commit_refs',
      ' ! [remote rejected] HEAD -> main (failure)',
    ]) expect(isRetryable({ status: 128, stderr }), stderr).toBe(true);
    for (const stderr of [
      REJECTED.stderr,
      RULESET,
      PROTECTED,
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
      'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413',
      "remote: error: GH013: Repository rule violations found for refs/heads/main.\n ! [remote rejected] HEAD -> main (push declined due to repository rule violations)",
      "fatal: pathspec 'docs/whereof.md' did not match any files",
    ]) expect(isRetryable({ status: 1, stderr }), stderr).toBe(false);
  });

  it('retryingExec(): retries git\'s clone, fetch, push and ls-remote, past its options; never another git command, nor another program', async () => {
    const clock = fakeClock();
    const seen = [];
    const exec = retryingExec(async (cmd, args) => { seen.push([cmd, ...args].join(' ')); return { status: 128, stdout: '', stderr: 'The requested URL returned error: 502' }; }, { sleep: clock.sleep });
    for (const args of [['clone', '-q', 'u', 'd'], ['fetch', '-q', 'origin'], ['-c', 'http.x=y', 'push', '-q', 'origin', 'HEAD'], ['ls-remote', 'origin']]) {
      seen.length = 0;
      expect((await exec('git', args)).status).toBe(128);
      expect(seen, args.join(' ')).toHaveLength(4);
    }
    for (const [cmd, args] of [['git', ['commit', '-q', '-m', 'push']], ['git', ['-c', 'user.name=push', 'add', '-A']], ['npx', ['push']]]) {
      seen.length = 0;
      await exec(cmd, args);
      expect(seen, `${cmd} ${args.join(' ')}`).toHaveLength(1);
    }
  });
});

describe('an `infra` result never reads as `pass` (§5.2, §10)', () => {
  it('a 5xx that outlasts the retries is `infra`, and the repository is deleted', async () => {
    const { result, g } = await segment({ state: kanonState(), routes: { [VARS]: fail('HTTP 502: Bad Gateway') } });
    expect(result).toMatchObject({ result: 'infra', repositoryAction: 'deleted' });
    expect(g.calls.filter((c) => c.key === VARS)).toHaveLength(4);
    expect(g.writes().map((c) => [c.key, c.body])).toEqual([
      [`PUT repos/${REPOSITORY}/topics`, { names: ['kanon-e2e', 'kanon-e2e-provisioned', 'kanon-e2e-infra'] }],
      [`DELETE repos/${REPOSITORY}`, undefined],
    ]);
  });

  it('an expired token is `infra`', () => {
    expect(classify(Object.assign(new Error('gh api exited 1: HTTP 401: Bad credentials'), { stderr: 'HTTP 401: Bad credentials' }))).toBe('infra');
  });

  it('a later phase can\'t turn `infra` into `pass`: the result is final once set', async () => {
    const steps = { phases: [{ kanon: [], act: [expectVars()] }, { kanon: [], act: [expectVars()] }] };
    const { state } = await segment({ steps, phase: 2, state: kanonState({ result: 'infra', firstFailure: { phase: 1, segment: 'kanon', index: null, verb: null, message: 'x' }, laid: true }), routes: { [VARS]: { total_count: 1 } } });
    expect(state.result).toBe('infra');
  });

  it('a `kanon` job\'s state that claims `pass` is refused, as `infra`', async () => {
    const { result } = await segment({ state: kanonState({ result: 'pass' }), routes: { [VARS]: { total_count: 1 } } });
    expect(result.result).toBe('infra');
    expect(result.firstFailure.message).toMatch(/state/);
  });

  it('a missing or unreadable state is `infra`, and the repository is still deleted', async () => {
    const missing = await segment({ phase: 2, state: null, stateProblem: 'the artifact e2e-state-sample-kanon-2 was not found' });
    expect(missing.result).toMatchObject({ result: 'infra', repositoryAction: 'deleted' });
    expect(missing.result.firstFailure.message).toMatch(/e2e-state-sample-kanon-2/);
    const dir = tempDir('state-');
    const bad = join(dir, 'state.json');
    execFileSync('sh', ['-c', `printf '{"schema":"kanon-e2e-state/v1","scenario":"other"}' > "${bad}"`]);
    expect(readState(bad).problem).toMatch(/scenario|missing/);
    expect(readState(join(dir, 'none.json')).problem).toMatch(/no state/);
  });
});

describe('the repository records the result, which a `kanon` job\'s code can\'t write (#24, R2)', () => {
  const twoPhases = { phases: [{ kanon: [], act: [expectVars()] }, { kanon: [], act: [expectVars()] }] };
  const recording = (topic) => stubGh({ ...repoRoutes({ topics: [...PROVISIONED, topic] }), [VARS]: { total_count: 1 } });

  it('an `act` job whose repository records a result passes it on as final, whatever the state says, and calls nothing more', async () => {
    for (const [topic, recorded] of [['kanon-e2e-failed', 'fail'], ['kanon-e2e-infra', 'infra'], ['kanon-e2e-passed', 'pass']]) {
      // A state planted to read as a scenario still running, with nothing failed.
      const g = recording(topic);
      const { state, result } = await segment({ phase: 2, steps: twoPhases, state: kanonState({ laid: true }), gh: g });
      expect(result, topic).toBeNull();
      expect(state, topic).toMatchObject({ result: recorded, finalized: true });
      expect(g.calls.map((c) => c.key), topic).toEqual([`GET repos/${REPOSITORY}`]);
    }
  });

  it('a recorded `fail` stands over a state that claims the scenario ended otherwise, or never failed', async () => {
    for (const planted of [kanonState({ laid: true }), kanonState({ result: 'pass', finalized: true, laid: true }), kanonState({ result: 'infra', finalized: true, laid: true })]) {
      const { state } = await segment({ phase: 2, steps: twoPhases, state: planted, gh: recording('kanon-e2e-failed') });
      expect(state.result).toBe('fail');
    }
  });

  it('a state that arrives final, with no result the repository records, is refused as `infra`, and the job ends the scenario', async () => {
    for (const r of ['pass', 'fail', 'infra']) {
      const { state, result, g } = await segment({ phase: 2, steps: twoPhases, state: kanonState({ result: r, finalized: true, laid: true }), routes: { [VARS]: { total_count: 1 } } });
      const want = r === 'fail' ? 'fail' : 'infra';
      expect(result, r).toMatchObject({ result: want, repositoryAction: want === 'fail' ? 'kept' : 'deleted' });
      expect(state.finalized, r).toBe(true);
      expect(g.calls.filter((c) => c.key === VARS), r).toEqual([]);
    }
    const { result } = await segment({ phase: 2, steps: twoPhases, state: kanonState({ finalized: true, laid: true }), routes: { [VARS]: { total_count: 1 } } });
    expect(result.firstFailure.message).toMatch(/arrived final.*records no result/);
  });

  it('never reads `pass` for a phase the scenario doesn\'t have, whatever state arrives: `infra`', async () => {
    // A two-phase scenario's phase 3, reached with a planted state that reads as still running.
    const { result } = await segment({ phase: 3, steps: twoPhases, state: kanonState({ laid: true }), routes: { [VARS]: { total_count: 1 } } });
    expect(result).toMatchObject({ result: 'infra', firstFailure: expect.objectContaining({ message: expect.stringMatching(/2 phases; there is no phase 3/) }) });
  });

  it('records the result as a topic before it ends the repository, and still ends it when the topic can\'t be written', async () => {
    const g = stubGh({ ...repoRoutes(), [VARS]: { total_count: 1 }, [`PUT repos/${REPOSITORY}/topics`]: fail('HTTP 502: Bad Gateway') });
    const { result } = await segment({ state: kanonState(), gh: g });
    expect(result).toMatchObject({ result: 'pass', repositoryAction: 'deleted' });
    expect(g.writes().map((c) => c.key)).toEqual([...Array(4).fill(`PUT repos/${REPOSITORY}/topics`), `DELETE repos/${REPOSITORY}`]);
  });
});

describe('a failure before the steps is `infra`, not `fail` (§5.2)', () => {
  it('a repository without the `kanon-e2e-provisioned` topic reads as `infra`, and no step runs', async () => {
    for (const kind of ['kanon', 'act']) {
      const g = stubGh({ ...repoRoutes({ topics: ['kanon-e2e'] }), [VARS]: { total_count: 1 } });
      const { state } = await segment({ segment: kind, state: kind === 'act' ? kanonState() : null, gh: g });
      expect(state.result, kind).toBe('infra');
      expect(state.firstFailure.message, kind).toMatch(/kanon-e2e-provisioned/);
      expect(g.calls.filter((c) => c.key === VARS), kind).toEqual([]);
    }
  });

  it('a `claude: subscription` scenario whose repository lacks the token\'s secret reads as `infra`', async () => {
    const scenario = scenarioJson('sample', { claude: 'subscription', tier: 'model' });
    const lacking = await segment({ scenario, state: kanonState(), routes: { [VARS]: { total_count: 1 } } });
    expect(lacking.result).toMatchObject({ result: 'infra' });
    expect(lacking.result.firstFailure.message).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    const holding = await segment({ scenario, state: kanonState(), gh: stubGh({ ...repoRoutes({ secrets: ['AUTHOR_APP_ID', 'CLAUDE_CODE_OAUTH_TOKEN'] }), [VARS]: { total_count: 1 } }) });
    expect(holding.result.result).toBe('pass');
  });

  it('a repository that is already deleted reads as `infra`, and nothing is deleted or archived', async () => {
    const { result, g } = await segment({ state: kanonState(), gh: stubGh(repoRoutes({ gone: true })) });
    expect(result).toMatchObject({ result: 'infra', repositoryAction: 'gone' });
    expect(result.firstFailure.message).toMatch(/already gone/);
    expect(g.writes()).toEqual([]);
  });
});

describe('the `kanon` segment (§5.2)', () => {
  const INIT = { schema: 'kanon-init/v1', status: 'steps-left', exitCode: 0, findings: [{ id: 'label.create' }] };
  const kanonSteps = (after = []) => ({ phases: [{ kanon: [{ verb: 'kanon.init', flags: ['--feature=review'] }, ...after], act: [] }] });

  it('clones the empty repository, lays start/ there for Kanon to see, and runs Kanon at the release in the clone', async () => {
    const npxCalls = [];
    const { state, result, work } = await segment({
      segment: 'kanon', steps: kanonSteps(), npx: (args, opts) => {
        npxCalls.push({ args, cwd: opts.cwd, readme: readFileSync(join(opts.cwd, 'README.md'), 'utf8') });
        return { status: 0, stdout: JSON.stringify(INIT) };
      },
    });
    expect(result).toBeNull();
    expect(npxCalls).toEqual([{ args: ['--yes', '--package', `github:yedeya-labs/kanon#${RELEASE}`, 'kanon', 'init', '--json', '--yes', '--no-apps', '--consent', 'no', '--feature=review'], cwd: join(work, 'clone'), readme: `Pinned to ${RELEASE} in ${REPOSITORY}.\n` }]);
    expect(state).toMatchObject({ schema: 'kanon-e2e-state/v1', scenario: 'sample', result: null, finalized: false, laid: false, documents: { init: { release: RELEASE, exit: 0, document: INIT } } });
    expect(state.steps).toEqual([expect.objectContaining({ segment: 'kanon', verb: 'kanon.init', outcome: 'pass' })]);
  });

  it('a false expectation in a `kanon` segment reads `fail` and writes nothing: the `act` job archives the repository', async () => {
    const { state, g } = await segment({
      segment: 'kanon', steps: kanonSteps([{ verb: 'expect.init', status: 'complete' }]),
      npx: () => ({ status: 0, stdout: JSON.stringify(INIT) }),
    });
    expect(state).toMatchObject({ result: 'fail', finalized: false });
    expect(g.writes()).toEqual([]);
    const act = await segment({ state, gh: stubGh(repoRoutes()) });
    expect(act.result).toMatchObject({ result: 'fail', repositoryAction: 'kept', firstFailure: expect.objectContaining({ segment: 'kanon', verb: 'expect.init' }) });
    expect(act.g.writes().map((c) => c.key)).toEqual([`PUT repos/${REPOSITORY}/topics`, `PATCH repos/${REPOSITORY}`]);
  });

  it('the scenario\'s deadline passing is `fail`', async () => {
    const { state } = await segment({ segment: 'kanon', phase: 2, steps: { phases: [{ kanon: [], act: [expectVars()] }, { kanon: [], act: [expectVars()] }] }, state: kanonState({ startedAt: fakeClock().now() - 61 * 60_000, laid: true }) });
    expect(state).toMatchObject({ result: 'fail', firstFailure: expect.objectContaining({ message: expect.stringMatching(/deadline of 60 minutes/) }) });
  });
});

describe('the result, `kanon-e2e-result/v1` (§5.1 step 8)', () => {
  it('holds the scenario, the release, the result, each step\'s duration and outcome, the first false expectation and the repository', async () => {
    const { result } = await segment({ state: kanonState(), routes: { [VARS]: { total_count: 0 } } });
    expect(Object.keys(result).sort()).toEqual(['finishedAt', 'firstFailure', 'release', 'repository', 'repositoryAction', 'result', 'run', 'scenario', 'schema', 'startedAt', 'steps', 'trigger'].sort());
    expect(result.run).toEqual(RUN);
    expect(result.trigger).toBe('nightly');
  });

  it('carries the real-model cost `expect.row` kept, `costUsd`, for the ledger (E10); none when no row was read', async () => {
    const kept = await segment({ state: kanonState({ costUsd: 0.42 }), routes: { [VARS]: { total_count: 1 } } });
    expect(kept.result).toMatchObject({ result: 'pass', costUsd: 0.42 });
    const failed = await segment({ state: kanonState({ costUsd: 31.5 }), routes: { [VARS]: { total_count: 0 } } });
    expect(failed.result).toMatchObject({ result: 'fail', costUsd: 31.5 });
    const none = await segment({ state: kanonState(), routes: { [VARS]: { total_count: 1 } } });
    expect(none.result).not.toHaveProperty('costUsd');
  });
});
