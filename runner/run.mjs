#!/usr/bin/env node
// The runner (Kanon plan 0012 §5.1, §5.2, §10; harness #16). One job runs one segment of one
// phase of one scenario: `kanon` (Kanon's code at the release under test, in a clone, with a
// read-only token, writing nothing to GitHub) or `act` (the harness's code, with the driver's
// wide token, pushing what the `kanon` job left and doing the rest). The run's state crosses from
// job to job as JSON (`kanon-e2e-state/v1`); the `kanon` job's tree crosses as an artifact the
// `act` job takes as data (lib/artifact.mjs).
//
// THE SCENARIO'S RESULT is `pass`, `fail` or `infra`, set once and never changed:
//   fail    an expectation was false, a step's or the scenario's deadline passed, or the harness's
//           own code went wrong;
//   infra   GitHub failed and the retries outlasted it, a token expired, the repository wasn't
//           provisioned or is gone, or the state didn't arrive;
//   pass    the last phase's `act` segment ran every step. Only an `act` job reads `pass`: a
//           state that arrives claiming it is refused, as `infra`.
// The `act` job that learns the result records it on the repository as a topic, `kanon-e2e-passed`,
// `kanon-e2e-failed` or `kanon-e2e-infra`, then ends it: `pass` and `infra` delete it, `fail` keeps
// it 24 hours, archived (decision 13), for the janitor. The topic is the scenario's record of
// having ended (#24, R2): only the act token can write it, never a `kanon` job's code, which can
// plant a state or an artifact. So an `act` job reads the repository before the state, and a
// result the repository records is final, whatever the state says; a state that says the scenario
// ended, with no such topic, is refused as `infra`.
//
//   node runner/run.mjs   (reads the environment below; always exits 0 once it has a state)

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { takeAsData } from './lib/artifact.mjs';
import { Fail } from './lib/fail.mjs';
import { api, notFound } from './lib/gh.mjs';
import { exec as realExec, ghProcess } from './lib/proc.mjs';
import { classify, infra, retrying, retryingExec } from './lib/retry.mjs';
import { substitute, substituteBytes } from './lib/substitute.mjs';
import { SETTINGS } from './sizing.mjs';
import { loadScenario } from './validate.mjs';
import { IDENTITY } from './verbs/files-commit.mjs';
import { VOCABULARY } from './vocabulary.mjs';

export const STATE_SCHEMA = 'kanon-e2e-state/v1';
export const RESULT_SCHEMA = 'kanon-e2e-result/v1';
export const TOPIC = 'kanon-e2e';
export const PROVISIONED = 'kanon-e2e-provisioned';
export const FAILED = 'kanon-e2e-failed';
export const PASSED = 'kanon-e2e-passed';
export const INFRA = 'kanon-e2e-infra';
/** The topic each result is recorded with on the repository, by the `act` job that learns it (#24, R2). */
export const RESULT_TOPICS = Object.freeze({ pass: PASSED, fail: FAILED, infra: INFRA });
/**
 * The result a repository's topics record, or null: `fail` over `infra` over `pass`, should it
 * carry more than one.
 * @param {unknown} topics
 * @returns {'pass' | 'fail' | 'infra' | null}
 */
export const recordedResult = (topics) => {
  const list = Array.isArray(topics) ? topics : [];
  return /** @type {const} */ (['fail', 'infra', 'pass']).find((r) => list.includes(RESULT_TOPICS[r])) ?? null;
};
/** The secret a `claude: subscription` scenario's repository holds (the `model-key` job writes it). */
export const MODEL_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';
export const LAY_MESSAGE = 'Lay the scenario\'s starting tree';
const RESULTS = ['pass', 'fail', 'infra'];

/** A fresh state, as the first `kanon` job starts it. */
const freshState = (/** @type {any} */ a, /** @type {number} */ now) => ({
  schema: STATE_SCHEMA, scenario: a.scenarioId, repository: a.repository, release: a.release, startedAt: now,
  laid: false, ref: null, steps: [], result: null, firstFailure: null, finalized: false,
});

/**
 * The problem with a state, or null: its schema, the scenario and repository it is for, and the
 * fields every state carries.
 * @param {any} s @param {{ scenario?: string, repository?: string }} [want]
 */
export const stateProblem = (s, want = {}) => {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'the state is not a JSON object';
  if (s.schema !== STATE_SCHEMA) return `the state's schema is \`${s.schema}\`, not \`${STATE_SCHEMA}\``;
  for (const k of ['scenario', 'repository', 'release', 'startedAt', 'laid', 'steps', 'finalized']) if (s[k] === undefined) return `the state is missing \`${k}\``;
  if (want.scenario && s.scenario !== want.scenario) return `the state is for the scenario \`${s.scenario}\`, not \`${want.scenario}\``;
  if (want.repository && s.repository !== want.repository) return `the state is for the repository \`${s.repository}\`, not \`${want.repository}\``;
  if (!Array.isArray(s.steps) || typeof s.startedAt !== 'number' || typeof s.laid !== 'boolean' || typeof s.finalized !== 'boolean') return 'the state\'s fields have the wrong types';
  if (s.result !== null && !RESULTS.includes(s.result)) return `the state's result \`${s.result}\` is not pass, fail or infra`;
  return null;
};

/**
 * Reads a state file: `{ state }` or `{ problem }`.
 * @param {string} path @param {{ scenario?: string, repository?: string }} [want]
 */
export const readState = (path, want = {}) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { problem: `no state at ${path}` };
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch (e) {
    return { problem: `the state at ${path} is not JSON (${/** @type {Error} */ (e).message})` };
  }
  const problem = stateProblem(s, want);
  return problem ? { problem } : { state: s };
};

/**
 * Writes the scenario's `start/` into `dest`, substitutions filled in, a binary file as it is.
 * @param {string} startDir @param {string} dest @param {Record<string, string>} values
 */
export const layStart = (startDir, dest, values) => {
  const walk = (/** @type {string} */ dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) throw new Error(`start/${relative(startDir, full)} is not a regular file`);
      const to = join(dest, substitute(relative(startDir, full), values));
      const bytes = readFileSync(full);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, substituteBytes(bytes, values));
    }
  };
  walk(startDir);
};

/** Milliseconds as an ISO time, for the result. @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/**
 * Runs one segment of one phase.
 * @param {{
 *   segment: 'kanon' | 'act', phase: number, scenarioDir: string, repository: string, release: string,
 *   trigger: string, harness: string, run: { id: string, attempt: string, url: string },
 *   state: any, stateProblem?: string, artifactDir?: string, work: string, remote: string,
 * }} a
 * @param {{ gh: (args: string[], input?: string) => Promise<any>, exec: Function, now: () => number, sleep: (ms: number) => Promise<void>, log?: (line: string) => void }} deps
 * @returns {Promise<{ state: any, result: any }>} the state to hand on, and the result when this job finalized the scenario
 */
export async function runSegment(a, deps) {
  const { scenario, steps } = loadScenario(a.scenarioDir);
  const log = deps.log ?? ((/** @type {string} */ l) => console.log(l));
  const gh = retrying(deps.gh, deps);
  const exec = retryingExec(deps.exec, deps);
  const ghCtx = { gh, repository: a.repository };
  const phases = steps.phases;
  const last = a.phase >= phases.length;

  // THE STATE: started by the first `kanon` job, handed on by every job after.
  let state = a.state;
  const problem = state === null || state === undefined
    ? (a.segment === 'kanon' && a.phase === 1 ? null : a.stateProblem ?? 'no state arrived from the previous job')
    : stateProblem(state, { scenario: scenario.id, repository: a.repository });
  if (state === null || state === undefined || problem) {
    const fresh = freshState({ ...a, scenarioId: scenario.id }, deps.now());
    state = problem
      ? { ...fresh, ...(state && typeof state === 'object' && typeof state.startedAt === 'number' ? { startedAt: state.startedAt } : {}), result: 'infra', firstFailure: { phase: a.phase, segment: a.segment, index: null, verb: null, message: `the state didn't arrive whole: ${problem}` } }
      : fresh;
  } else {
    state = structuredClone(state);
    if (state.finalized && a.segment === 'kanon') {
      log(`The scenario's result, ${state.result}, is final: this job passes the state through.`);
      return { state, result: null };
    }
    if (state.result === 'pass') {
      state.result = 'infra';
      state.firstFailure = { phase: a.phase, segment: a.segment, index: null, verb: null, message: 'the state arrived claiming `pass`, which only an `act` job reads: refused' };
    }
  }
  // Only the repository says the scenario ended (#24, R2), so a state's own word counts for nothing.
  const arrivedFinal = state.finalized === true;
  state.finalized = false;

  /** Records the first failure and sets the result, once. */
  const setResult = (/** @type {'fail' | 'infra'} */ r, /** @type {string} */ message, at = { index: null, verb: null }) => {
    if (state.result) return;
    state.result = r;
    state.firstFailure = { phase: a.phase, segment: a.segment, index: at.index, verb: at.verb, message };
    log(`${r}: ${message}`);
  };

  // THE REPOSITORY, AS `provision` LEFT IT. A `kanon` job with a result already set calls nothing.
  /** @type {any} */
  let repo = null;
  let gone = false;
  if (a.segment === 'act' || !state.result) {
    try {
      repo = await api(ghCtx, `repos/${a.repository}`);
    } catch (e) {
      if (notFound(e)) {
        gone = true;
        setResult('infra', `the repository ${a.repository} is already gone`);
      } else setResult(classify(e) === 'infra' ? 'infra' : 'fail', `reading the repository: ${/** @type {Error} */ (e).message}`);
    }
  }

  // THE RESULT THE REPOSITORY RECORDS (#24, R2): final, whatever the state says.
  const recorded = a.segment === 'act' ? recordedResult(repo?.topics) : null;
  if (recorded) {
    state.result = recorded;
    state.finalized = true;
    log(`The repository records the scenario's result, ${recorded}: this job passes the state through.`);
    return { state, result: null };
  }
  if (arrivedFinal) setResult('infra', 'the state arrived final, but the repository records no result: refused');
  if (a.phase > phases.length) setResult('infra', `the scenario has ${phases.length} phase${phases.length === 1 ? '' : 's'}; there is no phase ${a.phase}`);

  // THE PRECONDITIONS: each is the harness's, so a failure is `infra`; the deadline is the scenario's.
  if (!state.result && repo) {
    try {
      if (!(repo.topics ?? []).includes(PROVISIONED)) throw infra(`the repository lacks the \`${PROVISIONED}\` topic: \`provision\` didn't finish`);
      if (a.segment === 'act' && scenario.claude === 'subscription') {
        const secrets = await api(ghCtx, `repos/${a.repository}/actions/secrets?per_page=100`);
        if (!(secrets?.secrets ?? []).some((/** @type {any} */ s) => s.name === MODEL_SECRET)) throw infra(`the repository lacks the \`${MODEL_SECRET}\` secret: the \`model-key\` job didn't write it`);
      }
      if (deps.now() - state.startedAt > scenario.deadlineMinutes * 60_000) throw new Fail(`the scenario's deadline of ${scenario.deadlineMinutes} minutes passed before phase ${a.phase}'s ${a.segment} segment`);
    } catch (e) {
      setResult(classify(e), /** @type {Error} */ (e).message);
    }
  }

  const defaultBranch = repo?.default_branch ?? 'main';
  const values = { release: a.release, repository: a.repository };
  const clone = join(a.work, 'clone');
  const git = async (/** @type {string[]} */ args, cwd = clone) => {
    const r = await exec('git', args, { cwd });
    if (r.status !== 0) throw Object.assign(new Error(`git ${args.find((x) => !x.startsWith('-') && !x.includes('=')) ?? args[0]} exited ${r.status}: ${String(r.stderr).trim()}`), { stderr: r.stderr });
    return r;
  };

  if (!state.result) {
    /** @type {any[] | undefined} */
    let kanonFiles;
    try {
      if (a.segment === 'act') {
        // THE ARTIFACT FIRST, AS DATA, before git runs anywhere: refused, nothing is pushed.
        if (a.artifactDir !== undefined) {
          if (!existsSync(a.artifactDir)) throw infra(`the kanon job's tree didn't arrive (${a.artifactDir})`);
          kanonFiles = takeAsData(a.artifactDir);
        }
        await git(['clone', '-q', a.remote, clone], a.work);
        const empty = (await exec('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: clone })).status !== 0;
        if (empty) {
          await git(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
          layStart(join(a.scenarioDir, 'start'), clone, values);
          await git(['add', '-A']);
          await git(['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, 'commit', '-q', '-m', LAY_MESSAGE]);
          await git(['push', '-q', 'origin', `HEAD:refs/heads/${defaultBranch}`]);
          log(`Laid start/ as ${a.repository}'s first commit.`);
        }
        state.laid = true;
      } else {
        // The public repository, cloned with no token; start/ laid in the clone for Kanon to see,
        // and pushed by the `act` job.
        await git(['clone', '-q', a.remote, clone], a.work);
        if (!state.laid) layStart(join(a.scenarioDir, 'start'), clone, values);
      }
    } catch (e) {
      setResult(classify(e), /** @type {Error} */ (e).message);
    }

    // THE STEPS, in order; the first that throws ends the scenario, and the rest are skipped.
    const ctx = {
      repository: a.repository, release: a.release, harness: a.harness, trigger: a.trigger, defaultBranch,
      scenario, scenarioDir: a.scenarioDir, clone, kanonFiles, state, gh, exec, now: deps.now, sleep: deps.sleep,
    };
    const list = phases[a.phase - 1]?.[a.segment] ?? [];
    for (const [index, step] of list.entries()) {
      const record = { phase: a.phase, segment: a.segment, index, verb: step.verb, outcome: 'skipped', durationMs: 0 };
      state.steps.push(record);
      if (state.result) continue;
      const began = deps.now();
      try {
        await VOCABULARY[step.verb].run(step, ctx);
        record.outcome = 'pass';
      } catch (e) {
        record.outcome = classify(e);
        setResult(/** @type {'fail' | 'infra'} */ (record.outcome), /** @type {Error} */ (e).message, { index, verb: step.verb });
      }
      record.durationMs = deps.now() - began;
      log(`phase ${a.phase} ${a.segment} [${index}] ${step.verb}: ${record.outcome} (${record.durationMs} ms)`);
    }

    if (a.segment === 'act' && existsSync(join(clone, '.git'))) {
      const r = await exec('git', ['ls-remote', 'origin', `refs/heads/${defaultBranch}`], { cwd: clone });
      const sha = String(r.stdout).split(/\s/)[0];
      if (/^[0-9a-f]{40}$/.test(sha)) state.ref = sha;
    }
  }

  if (a.segment === 'kanon' || (!state.result && !last)) return { state, result: null };

  // THE END OF THE SCENARIO: the `act` job that learns its result records it, then ends the repository.
  if (!state.result) state.result = 'pass';
  let repositoryAction = 'left';
  if (!gone) {
    const topic = RESULT_TOPICS[/** @type {'pass' | 'fail' | 'infra'} */ (state.result)];
    try {
      const names = [...new Set([...(repo?.topics ?? []), TOPIC, topic])];
      await api(ghCtx, `repos/${a.repository}/topics`, { method: 'PUT', body: { names } });
    } catch (e) {
      log(`Could not record the result as the \`${topic}\` topic (${/** @type {Error} */ (e).message}); the repository is ended all the same.`);
    }
  }
  if (gone) repositoryAction = 'gone';
  else if (state.result === 'fail') {
    try {
      await api(ghCtx, `repos/${a.repository}`, { method: 'PATCH', body: { archived: true } });
      repositoryAction = 'kept';
    } catch (e) {
      log(`Could not keep the failed repository archived (${/** @type {Error} */ (e).message}); the janitor deletes it.`);
    }
  } else {
    try {
      await api(ghCtx, `repos/${a.repository}`, { method: 'DELETE' });
      repositoryAction = 'deleted';
    } catch (e) {
      if (notFound(e)) repositoryAction = 'gone';
      else log(`Could not delete the repository (${/** @type {Error} */ (e).message}); the janitor deletes it.`);
    }
  }
  state.finalized = true;
  const result = {
    schema: RESULT_SCHEMA, scenario: scenario.id, release: a.release, trigger: a.trigger, run: a.run,
    repository: a.repository, startedAt: iso(state.startedAt), finishedAt: iso(deps.now()),
    result: state.result, firstFailure: state.firstFailure, steps: state.steps, repositoryAction,
    // The real-model cost `expect.row` kept, read by the ledger as this scenario's history (E10).
    ...(typeof state.costUsd === 'number' ? { costUsd: state.costUsd } : {}),
  };
  log(`The scenario reads ${result.result}; its repository was ${repositoryAction}.`);
  return { state, result };
}

/** The step summary for a segment. @param {any} a @param {any} state @param {any} result */
const summary = (a, state, result) => [
  `## ${state.scenario}: phase ${a.phase}, ${a.segment}`,
  '',
  `Release ${a.release}, repository \`${a.repository}\`. Result so far: **${state.result ?? 'none yet'}**${result ? `, final; the repository was ${result.repositoryAction}` : ''}.`,
  ...(state.firstFailure ? ['', `First failure (phase ${state.firstFailure.phase}, ${state.firstFailure.segment}${state.firstFailure.verb ? `, \`${state.firstFailure.verb}\`` : ''}): ${state.firstFailure.message}`] : []),
  '',
  '| Phase | Segment | # | Verb | Outcome | ms |',
  '|---|---|---|---|---|---|',
  ...state.steps.map((/** @type {any} */ s) => `| ${s.phase} | ${s.segment} | ${s.index} | \`${s.verb}\` | ${s.outcome} | ${s.durationMs} |`),
  '',
].join('\n');

/**
 * `git`, as the `act` job runs it: authenticated to github.com with the job's token through the
 * environment, never written to disk. The `kanon` job's git runs with no token at all.
 * @param {string} token
 */
const authenticated = (token) => (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts = {}) => {
  if (cmd !== 'git') return realExec(cmd, args, opts);
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return realExec(cmd, args, { ...opts, env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: header, GIT_TERMINAL_PROMPT: '0' } });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const need = (/** @type {string} */ k) => {
    if (!env[k]) throw new Error(`run.mjs: ${k} is not set`);
    return /** @type {string} */ (env[k]);
  };
  const segment = /** @type {'kanon' | 'act'} */ (need('SEGMENT'));
  if (segment !== 'kanon' && segment !== 'act') throw new Error(`run.mjs: SEGMENT is \`${segment}\`, not kanon or act`);
  const phase = Number(need('PHASE'));
  const scenarioId = need('SCENARIO');
  const repository = `${SETTINGS.organisation}/${need('REPOSITORY_NAME')}`;
  const work = need('WORK');
  const out = need('OUT');
  mkdirSync(work, { recursive: true });
  mkdirSync(out, { recursive: true });
  const fresh = segment === 'kanon' && phase === 1;
  const read = fresh ? { state: null } : readState(join(need('STATE_DIR'), 'state.json'), { scenario: scenarioId, repository });
  const token = need('GH_TOKEN');
  const { state, result } = await runSegment({
    segment, phase, scenarioDir: join('scenarios', scenarioId), repository, release: need('RELEASE'), trigger: need('TRIGGER'),
    harness: need('GITHUB_REPOSITORY'), run: { id: need('GITHUB_RUN_ID'), attempt: need('GITHUB_RUN_ATTEMPT'), url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` },
    state: read.state ?? null, stateProblem: read.problem ? `${read.problem} (the artifact ${env.STATE_ARTIFACT ?? 'of the previous job'})` : undefined,
    artifactDir: segment === 'act' ? need('TREE_DIR') : undefined, work, remote: `https://github.com/${repository}.git`,
  }, { gh: ghProcess(env), exec: segment === 'act' ? authenticated(token) : realExec, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  writeFileSync(join(out, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  if (result) writeFileSync(join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  // The `kanon` job's tree crosses without its .git: the `act` job refuses one anyway.
  if (segment === 'kanon') rmSync(join(work, 'clone', '.git'), { recursive: true, force: true });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `finalized=${result ? 'true' : 'false'}\nresult=${state.result ?? ''}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary({ phase, segment, release: env.RELEASE, repository }, state, result));
}
