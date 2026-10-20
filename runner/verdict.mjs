#!/usr/bin/env node
// `verdict` (Kanon plan 0012 §5.2, §8.2, §8.3; harness #16, then E8, #40): reads each scenario's
// `kanon-e2e-result/v1` and gives the run's verdict, `kanon-e2e-verdict/v1`, over the scenarios
// that count. On a candidate's run those are the ones with `gate: true`, read from the catalogue at
// the run's commit as `plan` carries it, never from a result; on a nightly or a dispatch, every
// planned scenario counts.
//
//   pass        every scenario that counts read `pass`;
//   fail        one read `fail`, or `skipped` (E10's ledger: `skipped: budget`); or a candidate's
//               run has no gating scenario ("no scenario gates yet"); or the candidate's red issue
//               holds an open `fail`, whatever this run's scenarios did;
//   infra-only  nothing failed, but one read `infra` or left no result, or `start` failed, so the
//               Reporter couldn't post. Never `pass`.
//
// ONLY ON A CANDIDATE'S RUN, it reads and writes this repository's issues with its workflow token
// (`issues: write`, no key). Each is found by the harness's marker on its body's first line, never
// one quoted below it, among the open issues `github-actions[bot]` opened, never by its title:
//
//   `e2e: candidate-vX.Y.Z is red`  one per candidate, filed on a verdict that isn't `pass` and
//     edited by each later run of the candidate. Its marker records whether a run read `fail`. A
//     green run closes it only when none did; a `fail` needs a person to close it, with the cause.
//   `e2e: the Reporter can't post`  filed, or edited, when `start` failed; closed by the next run
//     whose `start` succeeded.
//
// It exits 0 on `pass` and 1 otherwise, after writing verdict.json, so the job's colour is the
// verdict's, and the job's conclusion is what Kanon's gate reads (docs/jobs.md).
//
//   node runner/verdict.mjs   (reads TRIGGER, RELEASE, CANDIDATE_SHA, START_RESULT, SCENARIOS,
//                              SKIPPED, RESULTS_DIR, GH_TOKEN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT; writes
//                              OUT/verdict.json, the step's `verdict` and `red-issue` outputs,
//                              and the step summary)

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { api } from './lib/gh.mjs';
import { ghProcess } from './lib/proc.mjs';
import { SETTINGS } from './sizing.mjs';

export const VERDICT_SCHEMA = 'kanon-e2e-verdict/v1';
const RESULT_SCHEMA = 'kanon-e2e-result/v1';
const PREFIX = 'kanon-e2e-result-';
/** Why a result reads `skipped`: a short word, such as E10's `budget`. */
const SKIP_REASON = /^[a-z][a-z-]{0,39}$/;

const H = SETTINGS.harness;
const BOT = 'github-actions[bot]';
const RED = 'kanon-e2e-red';
const REPORTER = 'kanon-e2e-reporter-cannot-post';
const RUNS = '<!-- kanon-e2e-runs -->';
/** GitHub's limit on an issue's body is 65,536 characters; the oldest runs go first past this. */
const BODY_MAX = 60_000;
const KEPT = /^kanon-e2e\/[A-Za-z0-9._-]+$/;

/** The red issue's title, for a candidate. @param {string} release */
export const redTitle = (release) => `e2e: ${release} is red`;
export const REPORTER_TITLE = 'e2e: the Reporter can\'t post';

/** A result `verdict` reads: `pass`, `fail`, `infra`, or `skipped` with its reason. Anything else is missing. @param {any} r */
const readable = (r) => r?.schema === RESULT_SCHEMA && typeof r.scenario === 'string'
  && (['pass', 'fail', 'infra'].includes(r.result) || (r.result === 'skipped' && typeof r.skipped === 'string' && SKIP_REASON.test(r.skipped)));

/**
 * The run's verdict. `planned` is `plan`'s scenarios, each with its `gate`; `held` is the
 * candidate's open red issue when it holds a `fail`. `own` is the verdict this run's scenarios
 * give before that hold.
 * @param {{ trigger?: string, planned: Array<{ id: string, gate?: unknown }>, results: any[], startResult: string, held?: { url: string } | null }} input
 */
export function judge({ trigger = '', planned, results, startResult, held = null }) {
  const candidate = trigger === 'candidate';
  const byId = new Map(results.filter(readable).map((r) => [r.scenario, r]));
  const scenarios = planned.map((p) => {
    const gate = p.gate === true;
    const r = byId.get(p.id);
    return { id: p.id, gate, counts: candidate ? gate : true, result: r?.result ?? 'missing', ...(r?.result === 'skipped' ? { skipped: r.skipped } : {}) };
  });
  const counted = scenarios.filter((s) => s.counts);
  const failed = counted.filter((s) => s.result === 'fail');
  const skipped = counted.filter((s) => s.result === 'skipped');
  const short = counted.filter((s) => s.result !== 'pass');
  let own;
  let reason;
  if (failed.length || skipped.length) {
    own = 'fail';
    reason = [
      failed.length ? `failed: ${failed.map((s) => s.id).join(', ')}` : '',
      skipped.length ? `skipped: ${skipped.map((s) => `${s.id} (${s.skipped})`).join(', ')}` : '',
    ].filter(Boolean).join('; ');
  } else if (startResult === 'failure') {
    own = 'infra-only';
    reason = '`start` failed: the Reporter could not post the check run, so no scenario ran';
  } else if (candidate && !counted.length) {
    own = 'fail';
    reason = 'no scenario gates yet';
  } else if (short.length || !planned.length) {
    own = 'infra-only';
    reason = short.length ? `no failure, but no pass for: ${short.map((s) => `${s.id} (${s.result})`).join(', ')}` : 'no scenario was planned';
  } else {
    own = 'pass';
    reason = `all ${counted.length} ${candidate ? 'gating ' : ''}scenario(s) passed`;
  }
  if (candidate && held && own !== 'fail') {
    return { schema: VERDICT_SCHEMA, verdict: 'fail', reason: `an earlier run's \`fail\` is still open in ${held.url}: a person closes it, with the cause (this run alone: ${own}, ${reason})`, own, scenarios };
  }
  return { schema: VERDICT_SCHEMA, verdict: own, reason, own, scenarios };
}

/**
 * The JSON a harness marker carries as an issue body's first line, or null. Only there: a body
 * quotes text from results below it, and a quoted marker never identifies an issue.
 * @param {unknown} body @param {string} kind
 */
const readMarker = (body, kind) => {
  const m = String(body ?? '').match(new RegExp(`^<!-- ${kind} (\\{[^\\n]*?\\}) -->(?:\\r?\\n|$)`));
  if (!m) return null;
  try {
    const o = JSON.parse(m[1]);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
};

/** Text from a result, inert in markdown: one line, in a code span, so no mention, link or reference. @param {unknown} s */
const inert = (s) => `\`${String(s).replace(/`/g, '\'').replace(/\s+/g, ' ').trim().slice(0, 300)}\``;

/** @param {{ id: string, attempt: string, url: string }} run */
const runLink = (run) => `[run ${run.id}, attempt ${run.attempt}](${run.url})`;

/**
 * One run's section in the red issue: its verdict, and each scenario that counted and didn't pass.
 * @param {ReturnType<typeof judge>} v @param {Map<string, any>} byId @param {{ id: string, attempt: string, url: string }} run
 */
const runSection = (v, byId, run) => [
  `### ${runLink(run)}: \`${v.verdict}\``,
  '',
  v.reason,
  '',
  ...v.scenarios.filter((s) => s.counts && s.result !== 'pass').map((s) => {
    const r = byId.get(s.id);
    const f = s.result === 'fail' ? r?.firstFailure : null;
    const where = f ? ` (phase ${Number(f.phase) || '?'}, ${f.segment === 'kanon' ? 'kanon' : 'act'}${Number.isInteger(f.index) ? `, step ${f.index}` : ''}${typeof f.verb === 'string' ? `, ${inert(f.verb)}` : ''})` : '';
    return [
      `- \`${s.id}\`${s.gate ? ' (gating)' : ''}: **${s.result}**${s.skipped ? ` (${s.skipped})` : ''}.`,
      f?.message !== undefined && f?.message !== null ? ` First failure${where}: ${inert(f.message)}.` : '',
      r?.repositoryAction === 'kept' && KEPT.test(String(r.repository)) ? ` Repository kept, archived, for 24 hours: https://github.com/${r.repository}` : '',
    ].join('');
  }),
  '',
].join('\n');

/** The red issue's body: its marker, what it means, and every run's section, the oldest dropped past GitHub's limit. */
const redBody = (/** @type {{ release: string, candidateSha: string, failSeen: boolean, runs: string }} */ { release, candidateSha, failSeen, runs }) => {
  const head = [
    `<!-- ${RED} ${JSON.stringify({ candidate: release, failSeen })} -->`,
    `**Kanon's \`${release}\` is red** on the harness's end-to-end gate (plan 0012 §8.3), at \`${candidateSha}\`.`,
    '',
    failSeen
      ? 'A run below read `fail`, so this issue holds the candidate\'s gate: every later run of it answers `fail` while this issue is open. **A person closes it, with the cause.** The only way past a red gate is a fix and a new candidate.'
      : 'No run below read `fail`, only `infra-only`: the next green run of this candidate closes this issue. The poll re-runs a `neutral` check run after an hour, within the candidate\'s six runs; after that, a dispatch does.',
    '',
    'Each run lists the gating scenarios that didn\'t pass. A `fail`\'s `act` job summary names its first failure in full.',
    '',
    RUNS,
    '',
  ].join('\n');
  const parts = runs.split(/\n(?=### )/);
  while (parts.length > 1 && head.length + parts.join('\n').length > BODY_MAX) parts.shift();
  return head + parts.join('\n');
};

/** The runs an issue's body already lists. @param {string} body */
const runsOf = (body) => (body.includes(RUNS) ? body.slice(body.indexOf(RUNS) + RUNS.length).trim() : '');

/**
 * The verdict, and on a candidate's run its issues: `verdict.json`'s document.
 * @param {{ trigger: string, release: string, candidateSha: string, startResult: string, run: { id: string, attempt: string, url: string }, planned: Array<{ id: string, gate?: unknown }>, results: any[] }} input
 * @param {{ gh: (args: string[], input?: string) => Promise<{ status: number, stdout: string, stderr: string }>, log?: (line: string) => void }} deps
 */
export async function give(input, { gh, log = () => {} }) {
  const { trigger, release, startResult, run, planned, results } = input;
  const candidate = trigger === 'candidate';
  const doc = (/** @type {ReturnType<typeof judge>} */ v, /** @type {string | null} */ redIssue, /** @type {string | null} */ reporterIssue) => ({
    schema: VERDICT_SCHEMA, verdict: v.verdict, reason: v.reason, trigger, release, candidateSha: candidate ? input.candidateSha : '', run, scenarios: v.scenarios, redIssue, reporterIssue,
  });
  if (!candidate) return doc(judge({ trigger, planned, results, startResult }), null, null);

  const ctx = { gh, repository: H };
  /** @type {any[] | null} */
  let issues = null;
  try {
    issues = (await api(ctx, `repos/${H}/issues?state=open&per_page=100`, { paginate: true }) ?? [])
      .filter((/** @type {any} */ i) => i?.user?.login === BOT && !i.pull_request)
      .sort((/** @type {any} */ a, /** @type {any} */ b) => a.number - b.number);
  } catch (e) {
    log(`::error title=verdict::could not list the harness's open issues: ${/** @type {Error} */ (e).message}`);
  }
  if (!issues) {
    // Whether the candidate's red issue holds a `fail` is unknown, so the run can't be green.
    const v = judge({ trigger, planned, results, startResult });
    if (v.verdict === 'pass') Object.assign(v, { verdict: 'infra-only', reason: 'every gating scenario passed, but the harness\'s issues couldn\'t be read, so whether the candidate\'s red issue holds a `fail` is unknown' });
    return doc(v, null, null);
  }

  const red = issues.map((i) => ({ issue: i, marker: readMarker(i.body, RED) })).find((x) => x.marker?.candidate === release) ?? null;
  const v = judge({ trigger, planned, results, startResult, held: red?.marker?.failSeen === true ? { url: red.issue.html_url } : null });
  const byId = new Map(results.filter(readable).map((r) => [r.scenario, r]));

  /** @type {string | null} */
  let reporterIssue = null;
  const reporter = issues.find((i) => readMarker(i.body, REPORTER));
  try {
    if (startResult === 'failure') {
      const line = `- ${runLink(run)}: \`start\` failed for \`${release}\` at \`${input.candidateSha}\`.`;
      const body = reporter ? `${String(reporter.body).trimEnd()}\n${line}\n` : [
        `<!-- ${REPORTER} {} -->`,
        '`start` couldn\'t create the `kanon-e2e` check run on Kanon\'s commit with the Reporter\'s key: a rotated key, or a lost installation on `yedeya-labs/kanon`. No scenario ran in the runs below, and each failed. Read their `start` job.',
        '',
        'The next candidate\'s run whose `start` succeeds closes this issue.',
        '',
        line,
        '',
      ].join('\n');
      const issue = reporter
        ? await api(ctx, `repos/${H}/issues/${reporter.number}`, { method: 'PATCH', body: { body } })
        : await api(ctx, `repos/${H}/issues`, { method: 'POST', body: { title: REPORTER_TITLE, body } });
      reporterIssue = issue?.html_url ?? reporter?.html_url ?? null;
    } else if (startResult === 'success' && reporter) {
      const body = `${String(reporter.body).trimEnd()}\n\nClosed by ${runLink(run)}: its \`start\` posted the check run.\n`;
      await api(ctx, `repos/${H}/issues/${reporter.number}`, { method: 'PATCH', body: { body, state: 'closed', state_reason: 'completed' } });
      reporterIssue = reporter.html_url;
    }
  } catch (e) {
    log(`::error title=verdict::could not write the \`${REPORTER_TITLE}\` issue: ${/** @type {Error} */ (e).message}`);
  }

  /** @type {string | null} */
  let redIssue = null;
  try {
    const runs = `${red ? `${runsOf(String(red.issue.body))}\n\n` : ''}${runSection(v, byId, run)}`;
    if (v.verdict !== 'pass') {
      const body = redBody({ release, candidateSha: input.candidateSha, failSeen: red?.marker?.failSeen === true || v.own === 'fail', runs });
      const issue = red
        ? await api(ctx, `repos/${H}/issues/${red.issue.number}`, { method: 'PATCH', body: { body } })
        : await api(ctx, `repos/${H}/issues`, { method: 'POST', body: { title: redTitle(release), body } });
      redIssue = issue?.html_url ?? red?.issue.html_url ?? null;
    } else if (red && red.marker?.failSeen !== true) {
      // Green, and every red run before it was `infra-only`: this run closes the issue.
      const body = `${redBody({ release, candidateSha: input.candidateSha, failSeen: false, runs })}\nClosed by ${runLink(run)}: green, and no run read \`fail\`.\n`;
      await api(ctx, `repos/${H}/issues/${red.issue.number}`, { method: 'PATCH', body: { body, state: 'closed', state_reason: 'completed' } });
      redIssue = red.issue.html_url;
    }
  } catch (e) {
    log(`::error title=verdict::could not write ${release}'s red issue: ${/** @type {Error} */ (e).message}`);
  }
  return doc(v, redIssue, reporterIssue);
}

/** A `result.json`, or null. @param {string} path */
const readResult = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Each result under `dir`, as `download-artifact`'s `pattern:` lays them (harness #30): several
 * matched artifacts, one directory each, named for the artifact; exactly one, in `dir` itself.
 * Several: a result counts only for the scenario its artifact's name gives. One: the name isn't on
 * disk, so its `result.json` counts for the scenario it gives, and nothing else in it counts. An
 * `act` job uploads `kanon-e2e-result-<scenario>` holding only that file, both from its own input.
 * @param {string} dir
 */
export const readResults = (dir) => {
  if (existsSync(join(dir, 'result.json'))) return [readResult(join(dir, 'result.json'))].filter(Boolean);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(PREFIX) && lstatSync(join(dir, n)).isDirectory()).flatMap((n) => {
    const r = readResult(join(dir, n, 'result.json'));
    return r?.scenario === n.slice(PREFIX.length) ? [r] : [];
  });
};

/**
 * The scenarios `plan`'s real-model ledger refused for their cost (E10), joined to the planned
 * ones and their results: each is planned, with its `gate` from `plan`, and reads `skipped` with
 * the ledger's word. No repository was made for it, so no result of its own can exist; one that
 * claims to (harness #24) is set aside for `plan`'s word.
 * @param {Array<{ id: string, gate?: unknown }>} planned @param {any[]} results
 * @param {Array<{ id: string, gate?: unknown, skipped: string }>} skipped
 */
export const withSkipped = (planned, results, skipped) => {
  const ids = new Set(skipped.map((s) => s.id));
  return {
    planned: [...planned.filter((p) => !ids.has(p.id)), ...skipped.map((s) => ({ id: s.id, gate: s.gate === true }))],
    results: [...results.filter((r) => !ids.has(r?.scenario)), ...skipped.map((s) => ({ schema: RESULT_SCHEMA, scenario: s.id, result: 'skipped', skipped: s.skipped }))],
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const { planned, results } = withSkipped(
    JSON.parse(env.SCENARIOS || '[]').map((/** @type {any} */ s) => ({ id: s.id, gate: s.gate === true })),
    readResults(env.RESULTS_DIR ?? 'results'),
    JSON.parse(env.SKIPPED || '[]'),
  );
  const run = { id: env.GITHUB_RUN_ID ?? '', attempt: env.GITHUB_RUN_ATTEMPT ?? '', url: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY ?? H}/actions/runs/${env.GITHUB_RUN_ID ?? ''}` };
  const v = await give({
    trigger: env.TRIGGER ?? '', release: env.RELEASE ?? '', candidateSha: env.CANDIDATE_SHA ?? '', startResult: env.START_RESULT ?? '', run, planned,
    results,
  }, { gh: ghProcess(env), log: (line) => console.log(line) });
  const out = env.OUT ?? 'verdict';
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'verdict.json'), `${JSON.stringify(v, null, 2)}\n`);
  // `report` reads these, the job's outputs, never verdict.json: code in a `kanon` job can upload
  // an artifact under any name in the run, but can't set another job's outputs (#24).
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `verdict=${v.verdict}\nred-issue=${v.redIssue ?? ''}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [
      `## Verdict: **${v.verdict}**`,
      '',
      v.reason,
      '',
      `A ${v.trigger} run of \`${v.release}\`${v.candidateSha ? ` at \`${v.candidateSha}\`` : ''}, ${runLink(v.run)}. ${v.trigger === 'candidate' ? 'The scenarios with `gate: true` count.' : 'Every planned scenario counts.'}`,
      ...(v.redIssue ? ['', `The red issue: ${v.redIssue}`] : []),
      ...(v.reporterIssue ? ['', `The \`${REPORTER_TITLE}\` issue: ${v.reporterIssue}`] : []),
      '',
      '| Scenario | Gate | Counts | Result |',
      '|---|---|---|---|',
      ...v.scenarios.map((s) => `| \`${s.id}\` | ${s.gate} | ${s.counts ? 'yes' : 'no'} | ${s.result}${s.skipped ? ` (${s.skipped})` : ''} |`),
      '',
    ].join('\n'));
  }
  console.log(`${v.verdict}: ${v.reason}`);
  process.exitCode = v.verdict === 'pass' ? 0 : 1;
}
