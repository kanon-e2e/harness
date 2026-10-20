#!/usr/bin/env node
// The long-lived upgrade signal (Kanon plan 0012 step E14, decision 20). Once a week
// `.github/workflows/upgrade-signal.yml` runs `kanon doctor --json` on the harness's own `main`,
// with the workflow's token, in a job of its own, and hands its document to this module, which
// asks three things:
//
//   current   Is the harness pinned to Kanon's latest stable release, or within seven days of
//             the promotion of the first stable release it hasn't moved to? A candidate ahead of
//             the latest stable release counts as current (`K-ADOPT-11`: running ahead is
//             allowed); a candidate whose own stable release is out is owed that release.
//   doctor    Is doctor healthy? No blocking finding, and nothing `unchecked` beyond the checks a
//             workflow's token can't run (ALLOWED_UNCHECKED, below). A finding that blocks
//             nothing, such as `pin.candidate`, is a note and doesn't count.
//   release   Did the harness's own latest completed release run, `release.yml` on `main`, go
//             green?
//
// A no to any one opens, or keeps open and updates, ONE issue in the harness, `long-lived upgrade
// behind`, naming which. When all three hold, it closes that issue. The issue is found by the
// marker on its body's first line among the open issues `github-actions[bot]` opened, never by its
// title, as `verdict` finds the red issue; a second one, should a race ever make one, is closed as
// a duplicate of the oldest, so there is never more than one open.
//
// This module runs no Kanon code. It reads doctor's document as data, written by the job before,
// which holds no write permission and no key (`K-AGENT-50`; harness #7).
//
//   node runner/upgrade-signal.mjs   (reads DOCTOR_JSON, GH_TOKEN, GITHUB_RUN_ID; writes the step
//                                     summary; exits 0 once it has answered and written the
//                                     issue, 1 when it couldn't read GitHub or write the issue)

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { api } from './lib/gh.mjs';
import { ghProcess } from './lib/proc.mjs';
import { retrying } from './lib/retry.mjs';
import { SETTINGS } from './sizing.mjs';

const H = SETTINGS.harness;
const K = SETTINGS.kanon;
const BOT = 'github-actions[bot]';
export const SIGNAL_TITLE = 'long-lived upgrade behind';
export const MARKER = 'kanon-e2e-upgrade-signal';
/** How long the harness may stay on a release once a newer stable one is promoted (E14). */
export const GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RELEASE_WORKFLOW = 'release.yml';

/**
 * The checks doctor may leave `unchecked` on a workflow's token, and why: each needs a permission
 * a workflow's `permissions:` can't grant (Kanon's docs/doctor.md, "The token it needs"). A
 * workflow's token has no Secrets permission and no Administration permission, on the repository
 * or the organisation. Every other check runs on the grants the doctor job holds (Contents,
 * Issues, Actions and Checks read; Metadata comes with every token), so its `unchecked` opens the
 * issue: `app-permissions` among them, which reads the latest dispatched `apps-check` run with
 * Actions read, and so says that `apps-check` needs running again.
 */
export const ALLOWED_UNCHECKED = Object.freeze({
  secrets: 'lists the repository\'s secret names: Secrets read, which a workflow\'s token can\'t hold',
  'token-age': 'reads when `CLAUDE_CODE_OAUTH_TOKEN` was last stored, from the same listing as `secrets`',
  'notify-secrets': 'lists the repository\'s and the organisation\'s secret names: Secrets read',
  'deploy-secrets': 'lists the organisation\'s secrets shared with the repository: Secrets read',
  'ruleset-bypass': 'reads each ruleset\'s bypass list, which GitHub shows only to a token that can edit it: Administration write',
  'deploy-retention': 'reads the artifact retention: Administration read',
  'unused-apps': 'lists the owner\'s App installations: the organisation\'s Administration read, an owner\'s token',
});

const EXACT = /^(candidate-)?v(\d+)\.(\d+)\.(\d+)$/;
/** An exact release's parts, or null. @param {unknown} tag */
export const parseRelease = (tag) => {
  const m = EXACT.exec(String(tag ?? ''));
  return m ? { tag: String(tag), candidate: m[1] !== undefined, core: [Number(m[2]), Number(m[3]), Number(m[4])] } : null;
};
/** @param {number[]} a @param {number[]} b */
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Kanon's stable releases from GitHub's release list, oldest first: published, not a draft, not a
 * prerelease, and named `vX.Y.Z`. A stable release is published when its candidate is promoted, so
 * its `published_at` is the promotion's date.
 * @param {any[]} list
 */
export const stableReleases = (list) => (Array.isArray(list) ? list : [])
  .filter((r) => r && !r.draft && !r.prerelease && r.published_at)
  .map((r) => ({ ...parseRelease(r.tag_name), publishedAt: String(r.published_at) }))
  .filter((r) => r.tag && !r.candidate && Number.isFinite(Date.parse(r.publishedAt)))
  .sort((a, b) => cmp(a.core, b.core));

/**
 * Is the harness current? It is when its pin is the latest stable release, or a candidate of a
 * later one; or when the first stable release it is behind was promoted no more than seven days
 * ago. The clock runs from that first one, not the latest: a pin two releases behind is late once
 * the first of the two is a week old, however new the second.
 * @param {{ pinned: unknown, releases: any[], now: Date }} input
 * @returns {{ ok: boolean, why: string }}
 */
export const judgeCurrent = ({ pinned, releases, now }) => {
  const pin = parseRelease(pinned);
  if (!pin) return { ok: false, why: `doctor didn't name the release the harness pins as an exact release (it gave \`${pinned ?? 'nothing'}\`)` };
  const stable = stableReleases(releases);
  const latest = stable.at(-1);
  if (!latest) return { ok: false, why: `no stable release of Kanon could be read from \`${K}\`'s releases` };
  if (!pin.candidate && cmp(pin.core, latest.core) === 0) return { ok: true, why: `pinned to \`${latest.tag}\`, Kanon's latest stable release` };
  if (pin.candidate && cmp(pin.core, latest.core) > 0) return { ok: true, why: `pinned to \`${pin.tag}\`, ahead of Kanon's latest stable release \`${latest.tag}\`` };
  if (!pin.candidate && cmp(pin.core, latest.core) > 0) return { ok: false, why: `pinned to \`${pin.tag}\`, which isn't one of Kanon's stable releases (the latest is \`${latest.tag}\`)` };
  // Behind: a stable release older than the latest, or a candidate whose own stable release, or a
  // later one, is out. What it owes first is the oldest stable release it hasn't reached.
  const owed = stable.filter((r) => (pin.candidate ? cmp(r.core, pin.core) >= 0 : cmp(r.core, pin.core) > 0));
  const first = owed[0];
  const age = now.getTime() - Date.parse(first.publishedAt);
  const days = (age / DAY_MS).toFixed(1);
  const behind = `pinned to \`${pin.tag}\`; \`${first.tag}\` was promoted ${days} days ago (${first.publishedAt})${latest.tag === first.tag ? '' : `, and the latest stable release is \`${latest.tag}\``}`;
  return age <= GRACE_DAYS * DAY_MS
    ? { ok: true, why: `${behind}: within the ${GRACE_DAYS} days the harness has to move` }
    : { ok: false, why: `${behind}: more than ${GRACE_DAYS} days behind` };
};

/**
 * Is doctor healthy? Its document must be `kanon-doctor/v1`, with no blocking finding, and with
 * nothing `unchecked` outside ALLOWED_UNCHECKED. A finding that blocks nothing is a note.
 * @param {any} doc
 * @returns {{ ok: boolean, why: string }}
 */
export const judgeDoctor = (doc) => {
  if (!doc || typeof doc !== 'object' || doc.schema !== 'kanon-doctor/v1') return { ok: false, why: 'the doctor job left no `kanon-doctor/v1` document' };
  if (doc.status === 'error') return { ok: false, why: `doctor couldn't run (exit ${doc.exitCode}): ${String(doc.error ?? 'no reason given')}` };
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  const unchecked = Array.isArray(doc.unchecked) ? doc.unchecked : [];
  const reasons = [];
  // A finding blocks unless it says it doesn't; `findings` is the status doctor gives one.
  const blocking = findings.filter((f) => f?.blocking !== false);
  if (blocking.length || doc.status === 'findings') {
    reasons.push(`it reports ${blocking.length || 'a'} blocking finding${blocking.length === 1 ? '' : 's'}${blocking.length ? `: ${blocking.map((f) => `\`${f.id}\` (${f.subject})`).join(', ')}` : ''}`);
  }
  const outside = unchecked.filter((u) => !Object.hasOwn(ALLOWED_UNCHECKED, String(u?.check)));
  if (outside.length) reasons.push(`it couldn't run ${outside.map((u) => `\`${u.check}\` (${u.subject}: ${u.reason})`).join('; ')}, which a workflow's token can run`);
  if (!['healthy', 'incomplete', 'findings'].includes(doc.status)) reasons.push(`its status is \`${doc.status}\``);
  if (reasons.length) return { ok: false, why: reasons.join('; and ') };
  const allowed = unchecked.map((u) => `\`${u.check}\``);
  return { ok: true, why: `no blocking finding${allowed.length ? `; unchecked only what a workflow's token can't run: ${[...new Set(allowed)].join(', ')}` : ', and every check ran'}` };
};

/**
 * Did the harness's latest completed release run go green?
 * @param {any} run the latest completed run of `release.yml` on `main`, or null
 * @returns {{ ok: boolean, why: string }}
 */
export const judgeRelease = (run) => {
  if (!run) return { ok: false, why: `no completed \`${RELEASE_WORKFLOW}\` run on \`main\` yet` };
  const link = run.html_url ? `[run ${run.id}](${run.html_url})` : `run ${run.id}`;
  return run.conclusion === 'success'
    ? { ok: true, why: `${link} concluded \`success\`` }
    : { ok: false, why: `${link} concluded \`${run.conclusion ?? 'nothing'}\`` };
};

const NAMES = /** @type {const} */ ({ current: 'the pin', doctor: 'doctor', release: 'the release run' });

/**
 * The three answers, and which failed.
 * @param {{ doctor: any, releases: any[], releaseRun: any, now: Date }} input
 */
export const decide = ({ doctor, releases, releaseRun, now }) => {
  const answers = {
    current: judgeCurrent({ pinned: doctor?.releases?.pinned, releases, now }),
    doctor: judgeDoctor(doctor),
    release: judgeRelease(releaseRun),
  };
  const failed = /** @type {Array<keyof typeof NAMES>} */ (Object.keys(answers)).filter((k) => !answers[k].ok);
  return { ok: failed.length === 0, failed, ...answers };
};

/** The marker on an issue body's first line, or null. @param {unknown} body */
const hasMarker = (body) => new RegExp(`^<!-- ${MARKER} \\{[^\\n]*?\\} -->(?:\\r?\\n|$)`).test(String(body ?? ''));

/** The table of the three answers. @param {ReturnType<typeof decide>} d */
const table = (d) => [
  '| Check | Holds | Why |',
  '|---|---|---|',
  `| Pinned to Kanon's latest stable release within ${GRACE_DAYS} days of its promotion | ${d.current.ok ? 'yes' : '**no**'} | ${d.current.why} |`,
  `| Doctor healthy on the workflow's token | ${d.doctor.ok ? 'yes' : '**no**'} | ${d.doctor.why} |`,
  `| The latest release run green | ${d.release.ok ? 'yes' : '**no**'} | ${d.release.why} |`,
].join('\n');

/** The issue's body. @param {ReturnType<typeof decide>} d @param {{ url: string }} run @param {Date} now */
export const issueBody = (d, run, now) => [
  `<!-- ${MARKER} ${JSON.stringify({ failed: d.failed })} -->`,
  `**The harness is behind on: ${d.failed.map((k) => NAMES[k]).join(', ')}.**`,
  '',
  `The weekly upgrade signal (Kanon plan 0012 step E14) read the harness's \`main\` on ${now.toISOString()} and found it isn't keeping up with Kanon's stable releases. It edits this issue on each run while anything is behind, and closes it on the first run where all three hold.`,
  '',
  table(d),
  '',
  `Doctor ran with the workflow's token, which can't run ${Object.keys(ALLOWED_UNCHECKED).map((c) => `\`${c}\``).join(', ')}: those may be \`unchecked\`, and nothing else. Run doctor with an admin's token for the rest.`,
  '',
  `Last read by ${run.url}.`,
  '',
].join('\n');

/**
 * Opens, edits or closes the one `long-lived upgrade behind` issue.
 * @param {ReturnType<typeof decide>} d
 * @param {{ gh: (args: string[], input?: string) => Promise<{ status: number, stdout: string, stderr: string }>, run: { url: string }, now: Date }} deps
 * @returns {Promise<{ action: 'opened' | 'updated' | 'closed' | 'none', issue: string | null, duplicates: string[] }>}
 */
export async function signal(d, { gh, run, now }) {
  const ctx = { gh, repository: H };
  const open = (await api(ctx, `repos/${H}/issues?state=open&per_page=100`, { paginate: true }) ?? [])
    .filter((/** @type {any} */ i) => i?.user?.login === BOT && !i.pull_request && hasMarker(i.body))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.number - b.number);
  const [kept, ...extra] = open;
  const duplicates = [];
  for (const dup of extra) {
    await api(ctx, `repos/${H}/issues/${dup.number}`, { method: 'PATCH', body: { body: `${String(dup.body).trimEnd()}\n\nClosed by ${run.url} as a duplicate of #${kept.number}.\n`, state: 'closed', state_reason: 'not_planned' } });
    duplicates.push(dup.html_url);
  }
  if (!d.ok) {
    const body = issueBody(d, run, now);
    const issue = kept
      ? await api(ctx, `repos/${H}/issues/${kept.number}`, { method: 'PATCH', body: { title: SIGNAL_TITLE, body } })
      : await api(ctx, `repos/${H}/issues`, { method: 'POST', body: { title: SIGNAL_TITLE, body } });
    return { action: kept ? 'updated' : 'opened', issue: issue?.html_url ?? kept?.html_url ?? null, duplicates };
  }
  if (!kept) return { action: 'none', issue: null, duplicates };
  const body = `${String(kept.body).trimEnd()}\n\nClosed by ${run.url} on ${now.toISOString()}: all three hold.\n\n${table(d)}\n`;
  await api(ctx, `repos/${H}/issues/${kept.number}`, { method: 'PATCH', body: { body, state: 'closed', state_reason: 'completed' } });
  return { action: 'closed', issue: kept.html_url, duplicates };
}

/**
 * What the signal reads from GitHub: Kanon's releases and the harness's latest completed release
 * run on `main`. Both repositories are public.
 * @param {{ gh: (args: string[], input?: string) => Promise<{ status: number, stdout: string, stderr: string }> }} deps
 */
export async function read({ gh }) {
  const releases = await api({ gh, repository: K }, `repos/${K}/releases?per_page=100`, { paginate: true }) ?? [];
  const runs = await api({ gh, repository: H }, `repos/${H}/actions/workflows/${RELEASE_WORKFLOW}/runs?branch=main&status=completed&per_page=1`);
  return { releases, releaseRun: runs?.workflow_runs?.[0] ?? null };
}

/** Doctor's document, or null when the doctor job left none that parses. @param {string} path */
export const readDoctor = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const gh = retrying(ghProcess(env), { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  const run = { url: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY ?? H}/actions/runs/${env.GITHUB_RUN_ID ?? ''}` };
  const now = new Date();
  try {
    const d = decide({ doctor: readDoctor(env.DOCTOR_JSON ?? 'doctor.json'), ...(await read({ gh })), now });
    const out = await signal(d, { gh, run, now });
    const line = d.ok ? 'all three hold' : `behind on: ${d.failed.map((k) => NAMES[k]).join(', ')}`;
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, [
        `## Upgrade signal: ${line}`,
        '',
        table(d),
        '',
        `The \`${SIGNAL_TITLE}\` issue: ${out.action}${out.issue ? `, ${out.issue}` : ''}${out.duplicates.length ? `; closed as duplicates: ${out.duplicates.join(', ')}` : ''}.`,
        '',
      ].join('\n'));
    }
    console.log(`${line}; issue ${out.action}${out.issue ? ` ${out.issue}` : ''}`);
  } catch (e) {
    console.log(`::error title=upgrade-signal::${/** @type {Error} */ (e).message}`);
    process.exitCode = 1;
  }
}
