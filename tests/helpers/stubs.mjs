// A stubbed `gh`, a stubbed process runner, a fake clock and scenario fixtures, for the
// validator's and the verbs' tests. No test reaches GitHub, npm or a real clock.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One `gh` call, as a route reads it: `api` calls by method and path (`GET repos/o/r/labels`),
 * with the body `--input -` sent; any other command by its words (`pr merge 3 -R o/r --squash`).
 * @param {string[]} args @param {string | undefined} input
 */
export const describeCall = (args, input) => {
  if (args[0] !== 'api') return { key: args.join(' '), method: null, path: null, body: undefined, args };
  let method = 'GET';
  let path = '';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-X') method = args[++i];
    else if (a === '--input' || a === '-H') i++;
    else if (!a.startsWith('-')) path = a;
  }
  return { key: `${method} ${path}`, method, path, body: input === undefined ? undefined : JSON.parse(input), args };
};

/**
 * A stubbed `gh`. Each route maps a call's key to its answer: a JSON value (printed, exit 0), a
 * function of the call returning one, or `fail(…)`. An unrouted call exits 1, so a verb that
 * calls what its test didn't expect fails by name.
 * @param {Record<string, any>} routes
 */
export const stubGh = (routes) => {
  /** @type {Array<ReturnType<typeof describeCall>>} */
  const calls = [];
  /** @param {string[]} args @param {string} [input] */
  const gh = async (args, input) => {
    const call = describeCall(args, input);
    calls.push(call);
    if (!(call.key in routes)) return { status: 1, stdout: '', stderr: `stub: no route for ${call.key}` };
    let answer = routes[call.key];
    if (typeof answer === 'function') answer = answer(call);
    if (answer && answer[FAIL]) return { status: answer.status, stdout: '', stderr: answer.stderr };
    return { status: 0, stdout: answer === undefined ? '' : JSON.stringify(answer), stderr: '' };
  };
  return { gh, calls, writes: () => calls.filter((c) => c.method && c.method !== 'GET') };
};

const FAIL = Symbol('fail');
/** A `gh` answer that exits non-zero. */
export const fail = (stderr = 'HTTP 404', status = 1) => ({ [FAIL]: true, status, stderr });

/** Answers in turn, the last one repeated: what a poll sees as the world changes. */
export const inTurn = (...answers) => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
};

/**
 * A stubbed process runner (`npx`, `git`, `node`). Each route is a function of the call that
 * returns `{ status, stdout }`, matched by the first route whose test passes.
 * @param {Array<[(c: { cmd: string, args: string[], cwd?: string }) => boolean, (c: any) => any]>} routes
 */
export const stubExec = (routes = []) => {
  /** @type {Array<{ cmd: string, args: string[], cwd?: string }>} */
  const calls = [];
  /** @param {string} cmd @param {string[]} args @param {{ cwd?: string }} [opts] */
  const exec = async (cmd, args, opts = {}) => {
    const call = { cmd, args, cwd: opts.cwd };
    calls.push(call);
    const route = routes.find(([test]) => test(call));
    if (!route) return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '', ...route[1](call) };
  };
  return { exec, calls };
};

/** A clock that only moves when the code under test sleeps, recording each sleep. */
export const fakeClock = (start = 1_700_000_000_000) => {
  let t = start;
  /** @type {number[]} */
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (/** @type {number} */ ms) => { sleeps.push(ms); t += ms; },
    sleeps,
  };
};

export const REPO = 'kanon-e2e/e2e-sample-123-1';
export const RELEASE = 'candidate-v0.41.0';

/** A verb's context, as the runner hands it over (E4), with every outside call stubbed. */
export const context = (over = {}) => {
  const clock = fakeClock();
  return {
    repository: REPO,
    release: RELEASE,
    harness: 'kanon-e2e/harness',
    trigger: 'nightly',
    defaultBranch: 'main',
    scenario: { id: 'sample', apps: ['author', 'judge'] },
    scenarioDir: '/nonexistent',
    clone: '/nonexistent',
    state: {},
    gh: stubGh({}).gh,
    exec: stubExec().exec,
    now: clock.now,
    sleep: clock.sleep,
    clock,
    ...over,
  };
};

/** A fresh, empty directory. */
export const tempDir = (prefix = 'harness-') => mkdtempSync(join(tmpdir(), prefix));

/** Writes `files` (relative path → text) under `root`. */
export const writeTree = (root, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

/** A valid `scenario.json` for the directory `id`. */
export const scenarioJson = (id = 'sample', over = {}) => ({
  id, family: 'install', tier: 'none', gate: false, apps: ['author', 'judge'], claude: 'none', deadlineMinutes: 60, ...over,
});

/**
 * Writes a scenario directory in a fresh `scenarios/` root and returns its path.
 * @param {{ id?: string, scenario?: any, steps?: any, start?: Record<string, string>, extra?: Record<string, string> }} s
 */
export const writeScenario = ({ id = 'sample', scenario, steps, start = { 'README.md': 'Pinned to {{release}} in {{repository}}.\n' }, extra = {} } = {}) => {
  const root = tempDir('scenarios-');
  const dir = join(root, id);
  writeTree(dir, {
    'scenario.json': JSON.stringify(scenario ?? scenarioJson(id)),
    'steps.json': JSON.stringify(steps ?? { phases: [{ kanon: [{ verb: 'kanon.init', flags: ['--feature=review'] }], act: [] }] }),
    ...Object.fromEntries(Object.entries(start).map(([p, t]) => [`start/${p}`, t])),
    ...extra,
  });
  return dir;
};
