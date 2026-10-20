import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UNCHECKED, decide, GRACE_DAYS, judgeCurrent, judgeDoctor, judgeRelease, MARKER, read, SIGNAL_TITLE, signal, stableReleases,
} from '../runner/upgrade-signal.mjs';
import { stubGh } from './helpers/stubs.mjs';
import { readWorkflows, workflowText } from './helpers/workflows.mjs';

/**
 * The long-lived upgrade signal (Kanon plan 0012 step E14, decision 20), on fixtures. E14's
 * criteria: a pin one stable release behind for eight days opens the issue; a healthy, current
 * harness closes it; a doctor `unchecked` outside the allowed list opens it. Its mutations:
 * treating a pin seven days behind as current after eight, and closing the issue while doctor has
 * a blocking finding, each turn a named test red ("the mutations' tests", below).
 */

const H = 'kanon-e2e/harness';
const K = 'yedeya-labs/kanon';
const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const NOW = new Date('2026-11-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const RUN = { url: `https://github.com/${H}/actions/runs/1` };

const rel = (tag, publishedAt, more = {}) => ({ tag_name: tag, published_at: publishedAt, draft: false, prerelease: tag.startsWith('candidate-'), ...more });
/** Kanon's releases, `v0.41.0` promoted `days` ago, and a later candidate. */
const releases = (days) => [rel('candidate-v0.42.0', ago(1)), rel('v0.41.0', ago(days)), rel('candidate-v0.41.0', ago(days + 3)), rel('v0.40.2', ago(days + 4))];

const doctorDoc = (over = {}) => ({
  schema: 'kanon-doctor/v1',
  kanon: 'v0.41.0',
  repository: H,
  releases: { pins: ['v0.41.0'], pinned: 'v0.41.0', to: null, checked: 'v0.41.0', stable: 'v0.41.0' },
  status: 'incomplete',
  exitCode: 4,
  findings: [{ id: 'label.missing', category: 'label', blocking: false, subject: H, message: 'x', fix: { text: 'x', commands: [], url: null } }],
  waived: [],
  unchecked: [{ check: 'secrets', subject: H, reason: "the token can't list the repository's secret names (it needs admin access)" }],
  notes: [],
  ...over,
});
const pinned = (tag) => ({ releases: { pins: [tag], pinned: tag, to: null, checked: tag, stable: 'v0.41.0' } });
const green = { id: 7, conclusion: 'success', html_url: `https://github.com/${H}/actions/runs/7` };
const blocking = { id: 'ruleset.rule-missing', category: 'ruleset', blocking: true, subject: 'main', message: 'x', fix: { text: 'x', commands: [], url: null } };

const marked = (number, failed = ['current'], more = {}) => ({ number, html_url: `https://github.com/${H}/issues/${number}`, user: BOT, body: `<!-- ${MARKER} ${JSON.stringify({ failed })} -->\nbody\n`, ...more });
const LIST = `GET repos/${H}/issues?state=open&per_page=100`;
/** A stubbed `gh` whose open issues are `open`, answering each write with the issue it made or changed. */
const issues = (open = []) => stubGh({
  [LIST]: [open],
  [`POST repos/${H}/issues`]: { number: 99, html_url: `https://github.com/${H}/issues/99` },
  ...Object.fromEntries(open.map((i) => [`PATCH repos/${H}/issues/${i.number}`, { number: i.number, html_url: i.html_url }])),
});

describe('E14\'s criteria, on fixtures', () => {
  it('a pin one stable release behind for eight days opens the issue, naming the pin', async () => {
    const d = decide({ doctor: doctorDoc(pinned('v0.40.2')), releases: releases(8), releaseRun: green, now: NOW });
    expect(d).toMatchObject({ ok: false, failed: ['current'], doctor: { ok: true }, release: { ok: true } });
    const { gh, writes } = issues();
    expect(await signal(d, { gh, run: RUN, now: NOW })).toMatchObject({ action: 'opened' });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ key: `POST repos/${H}/issues`, body: { title: SIGNAL_TITLE } });
    expect(writes()[0].body.body).toMatch(new RegExp(`^<!-- ${MARKER} \\{"failed":\\["current"\\]\\} -->\n\\*\\*The harness is behind on: the pin\\.\\*\\*`));
    expect(writes()[0].body.body).toContain('`v0.41.0` was promoted 8.0 days ago');
  });

  it('a healthy, current harness closes the issue', async () => {
    const d = decide({ doctor: doctorDoc(), releases: releases(30), releaseRun: green, now: NOW });
    expect(d).toMatchObject({ ok: true, failed: [] });
    const { gh, writes } = issues([marked(12)]);
    expect(await signal(d, { gh, run: RUN, now: NOW })).toMatchObject({ action: 'closed', issue: `https://github.com/${H}/issues/12` });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ key: `PATCH repos/${H}/issues/12`, body: { state: 'closed', state_reason: 'completed' } });
    expect(writes()[0].body.body).toContain(`Closed by ${RUN.url}`);
  });

  it('a healthy, current harness with no issue open writes nothing', async () => {
    const { gh, writes } = issues();
    expect(await signal(decide({ doctor: doctorDoc(), releases: releases(30), releaseRun: green, now: NOW }), { gh, run: RUN, now: NOW })).toMatchObject({ action: 'none', issue: null });
    expect(writes()).toEqual([]);
  });

  it('a doctor `unchecked` outside the allowed list opens the issue, naming doctor and the check', async () => {
    const doc = doctorDoc({ unchecked: [...doctorDoc().unchecked, { check: 'app-permissions', subject: 'kanon-e2e-judge', reason: 'run apps-check again' }] });
    const d = decide({ doctor: doc, releases: releases(30), releaseRun: green, now: NOW });
    expect(d).toMatchObject({ ok: false, failed: ['doctor'] });
    expect(d.doctor.why).toContain('`app-permissions` (kanon-e2e-judge: run apps-check again)');
    const { gh, writes } = issues();
    expect(await signal(d, { gh, run: RUN, now: NOW })).toMatchObject({ action: 'opened' });
    expect(writes()[0].body.body).toContain('**The harness is behind on: doctor.**');
  });
});

describe('the mutations\' tests', () => {
  it('a pin seven days behind is current, and eight days behind is not (treating eight as current turns this red)', () => {
    expect(judgeCurrent({ pinned: 'v0.40.2', releases: releases(7), now: NOW }).ok).toBe(true);
    expect(judgeCurrent({ pinned: 'v0.40.2', releases: releases(6.9), now: NOW }).ok).toBe(true);
    expect(judgeCurrent({ pinned: 'v0.40.2', releases: releases(8), now: NOW }).ok).toBe(false);
    expect(judgeCurrent({ pinned: 'v0.40.2', releases: releases(7.01), now: NOW }).ok).toBe(false);
    expect(GRACE_DAYS).toBe(7);
  });

  it('a blocking finding keeps the issue open: never closed while doctor has one', async () => {
    const doc = doctorDoc({ status: 'findings', exitCode: 1, findings: [...doctorDoc().findings, blocking] });
    const d = decide({ doctor: doc, releases: releases(30), releaseRun: green, now: NOW });
    expect(d).toMatchObject({ ok: false, failed: ['doctor'] });
    expect(d.doctor.why).toContain('`ruleset.rule-missing` (main)');
    const { gh, writes } = issues([marked(12)]);
    expect(await signal(d, { gh, run: RUN, now: NOW })).toMatchObject({ action: 'updated' });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body.state).toBeUndefined();
    expect(writes()[0].body).toMatchObject({ title: SIGNAL_TITLE });
  });
});

describe('the pin', () => {
  it('the clock runs from the first stable release the pin is behind, not the latest', () => {
    const list = [rel('v0.42.0', ago(1)), rel('v0.41.0', ago(9)), rel('v0.40.2', ago(20))];
    expect(judgeCurrent({ pinned: 'v0.40.2', releases: list, now: NOW })).toMatchObject({ ok: false });
    expect(judgeCurrent({ pinned: 'v0.40.2', releases: list, now: NOW }).why).toContain('`v0.41.0` was promoted 9.0 days ago');
    expect(judgeCurrent({ pinned: 'v0.41.0', releases: list, now: NOW }).ok).toBe(true);
    expect(judgeCurrent({ pinned: 'v0.42.0', releases: list, now: NOW }).ok).toBe(true);
  });

  it('a candidate ahead of the latest stable release is current; one whose stable release is out is owed it', () => {
    expect(judgeCurrent({ pinned: 'candidate-v0.42.0', releases: releases(30), now: NOW }).ok).toBe(true);
    expect(judgeCurrent({ pinned: 'candidate-v0.41.0', releases: releases(3), now: NOW }).ok).toBe(true);
    expect(judgeCurrent({ pinned: 'candidate-v0.41.0', releases: releases(8), now: NOW })).toMatchObject({ ok: false });
  });

  it('the pin isn\'t current when it can\'t be read, or no stable release can', () => {
    expect(judgeCurrent({ pinned: undefined, releases: releases(1), now: NOW }).ok).toBe(false);
    expect(judgeCurrent({ pinned: 'main', releases: releases(1), now: NOW }).ok).toBe(false);
    expect(judgeCurrent({ pinned: 'v0.41.0', releases: [], now: NOW }).ok).toBe(false);
    expect(judgeCurrent({ pinned: 'v9.0.0', releases: releases(1), now: NOW }).ok).toBe(false);
  });

  it('reads only published stable releases, `vX.Y.Z`, oldest first', () => {
    const list = [rel('v0.41.0', ago(1)), rel('v0.43.0', ago(1), { draft: true }), rel('v0.42.0', ago(1), { prerelease: true }), rel('candidate-v0.44.0', ago(1)), rel('latest', ago(1), { prerelease: false }), rel('v0.40.2', ago(2))];
    expect(stableReleases(list).map((r) => r.tag)).toEqual(['v0.40.2', 'v0.41.0']);
  });
});

describe('doctor', () => {
  it('allows exactly the checks a workflow\'s token can\'t run, each with its reason', () => {
    expect(Object.keys(ALLOWED_UNCHECKED).sort()).toEqual(['deploy-retention', 'deploy-secrets', 'notify-secrets', 'ruleset-bypass', 'secrets', 'token-age', 'unused-apps']);
    for (const [check, why] of Object.entries(ALLOWED_UNCHECKED)) expect(why, check).toMatch(/Secrets|Administration|`secrets`/);
    const all = Object.keys(ALLOWED_UNCHECKED).map((check) => ({ check, subject: H, reason: 'x' }));
    expect(judgeDoctor(doctorDoc({ unchecked: all })).ok).toBe(true);
  });

  it('a check a workflow\'s token can run, left unchecked, fails it: `app-permissions`, `turn-cap-runs`, `ruleset`', () => {
    for (const check of ['app-permissions', 'turn-cap-runs', 'ruleset', 'telemetry-runs']) {
      expect(judgeDoctor(doctorDoc({ unchecked: [{ check, subject: H, reason: 'x' }] })).ok, check).toBe(false);
    }
  });

  it('a finding that blocks nothing is a note: healthy and incomplete both pass', () => {
    expect(judgeDoctor(doctorDoc()).ok).toBe(true);
    expect(judgeDoctor(doctorDoc({ status: 'healthy', exitCode: 0, unchecked: [], findings: [] })).ok).toBe(true);
  });

  it('a finding with no `blocking` field counts as blocking, and a `findings` status fails it even with none listed', () => {
    expect(judgeDoctor(doctorDoc({ findings: [{ id: 'pin.mixed', subject: H }] })).ok).toBe(false);
    expect(judgeDoctor(doctorDoc({ status: 'findings', exitCode: 1, findings: [] })).ok).toBe(false);
  });

  it('no document, another schema, an error document or an unknown status fails it', () => {
    expect(judgeDoctor(null).ok).toBe(false);
    expect(judgeDoctor({ schema: 'kanon-init/v1' }).ok).toBe(false);
    expect(judgeDoctor({ schema: 'kanon-doctor/v1', kanon: 'v0.41.0', status: 'error', exitCode: 3, error: 'nothing pins Kanon' })).toMatchObject({ ok: false, why: expect.stringContaining('nothing pins Kanon') });
    expect(judgeDoctor(doctorDoc({ status: 'usage' })).ok).toBe(false);
  });

  it('an error document fails the pin too, since doctor names no release', () => {
    const d = decide({ doctor: { schema: 'kanon-doctor/v1', status: 'error', exitCode: 3, error: 'x' }, releases: releases(30), releaseRun: green, now: NOW });
    expect(d.failed).toEqual(['current', 'doctor']);
  });
});

describe('the release run', () => {
  it('green only on `success`; red, cancelled or none opens the issue, naming the release run', async () => {
    expect(judgeRelease(green).ok).toBe(true);
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure', 'skipped']) expect(judgeRelease({ ...green, conclusion }).ok, conclusion).toBe(false);
    expect(judgeRelease(null)).toMatchObject({ ok: false, why: expect.stringContaining('no completed') });
    const d = decide({ doctor: doctorDoc(), releases: releases(30), releaseRun: { ...green, conclusion: 'failure' }, now: NOW });
    expect(d.failed).toEqual(['release']);
    const { gh, writes } = issues();
    await signal(d, { gh, run: RUN, now: NOW });
    expect(writes()[0].body.body).toContain('**The harness is behind on: the release run.**');
  });

  it('names every check that failed', async () => {
    const d = decide({ doctor: doctorDoc({ ...pinned('v0.40.2'), status: 'findings', findings: [blocking] }), releases: releases(8), releaseRun: null, now: NOW });
    expect(d.failed).toEqual(['current', 'doctor', 'release']);
    const { gh, writes } = issues();
    await signal(d, { gh, run: RUN, now: NOW });
    expect(writes()[0].body.body).toContain('**The harness is behind on: the pin, doctor, the release run.**');
  });
});

describe('one issue, never two', () => {
  const behind = () => decide({ doctor: doctorDoc(pinned('v0.40.2')), releases: releases(8), releaseRun: green, now: NOW });

  it('an open issue is edited, never a second one opened', async () => {
    const { gh, writes } = issues([marked(12)]);
    expect(await signal(behind(), { gh, run: RUN, now: NOW })).toMatchObject({ action: 'updated', issue: `https://github.com/${H}/issues/12` });
    expect(writes().map((w) => w.key)).toEqual([`PATCH repos/${H}/issues/12`]);
    expect(writes()[0].body).toMatchObject({ title: SIGNAL_TITLE });
    expect(writes()[0].body.body).toContain('**The harness is behind on: the pin.**');
  });

  it('two open, as a race could leave, keep the oldest and close the other as a duplicate', async () => {
    const { gh, writes } = issues([marked(15), marked(12)]);
    expect(await signal(behind(), { gh, run: RUN, now: NOW })).toMatchObject({ action: 'updated', issue: `https://github.com/${H}/issues/12`, duplicates: [`https://github.com/${H}/issues/15`] });
    expect(writes().map((w) => [w.key, w.body.state ?? null])).toEqual([[`PATCH repos/${H}/issues/15`, 'closed'], [`PATCH repos/${H}/issues/12`, null]]);
    expect(writes()[0].body).toMatchObject({ state_reason: 'not_planned' });
  });

  it('finds the issue by its marker on the first line among `github-actions[bot]`\'s, never by its title', async () => {
    const quoted = marked(20, ['current'], { body: `A person quoting it:\n<!-- ${MARKER} {} -->\n` });
    const person = marked(21, ['current'], { user: { login: 'someone', type: 'User' } });
    const pr = marked(22, ['current'], { pull_request: {} });
    const titled = { number: 23, html_url: 'x', user: BOT, title: SIGNAL_TITLE, body: 'no marker' };
    const { gh, writes } = issues([quoted, person, pr, titled]);
    expect(await signal(behind(), { gh, run: RUN, now: NOW })).toMatchObject({ action: 'opened' });
    expect(writes().map((w) => w.key)).toEqual([`POST repos/${H}/issues`]);
  });

  it('a call GitHub refuses throws, so the run fails rather than open a second issue later', async () => {
    const { gh } = stubGh({});
    await expect(signal(behind(), { gh, run: RUN, now: NOW })).rejects.toThrow(/gh api GET/);
  });
});

describe('what it reads from GitHub', () => {
  it('Kanon\'s releases, and the harness\'s latest completed release run on `main`', async () => {
    const { gh, calls } = stubGh({
      [`GET repos/${K}/releases?per_page=100`]: [releases(8)],
      [`GET repos/${H}/actions/workflows/release.yml/runs?branch=main&status=completed&per_page=1`]: { total_count: 1, workflow_runs: [green] },
    });
    expect(await read({ gh })).toEqual({ releases: releases(8), releaseRun: green });
    expect(calls.map((c) => c.args.includes('--paginate'))).toEqual([true, false]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('no release run yet reads as none', async () => {
    const { gh } = stubGh({
      [`GET repos/${K}/releases?per_page=100`]: [[]],
      [`GET repos/${H}/actions/workflows/release.yml/runs?branch=main&status=completed&per_page=1`]: { total_count: 0, workflow_runs: [] },
    });
    expect((await read({ gh })).releaseRun).toBeNull();
  });
});

describe('`upgrade-signal.yml`', () => {
  const w = readWorkflows()['upgrade-signal.yml'];
  const text = workflowText('upgrade-signal.yml');
  const steps = (job) => w.jobs[job].steps;
  const runs = (job) => steps(job).map((s) => String(s.run ?? '')).join('\n');

  it('runs weekly and on dispatch, one at a time, and grants nothing by default', () => {
    expect(Object.keys(w.on)).toEqual(['schedule', 'workflow_dispatch']);
    expect(w.on.schedule).toHaveLength(1);
    expect(w.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* [0-6]$/);
    expect(w.permissions).toEqual({});
    expect(w.concurrency).toMatchObject({ group: 'upgrade-signal', 'cancel-in-progress': false });
  });

  it('its only credential is the workflow\'s token: no environment, no secret, no App token', () => {
    expect(text).not.toMatch(/\bsecrets\s*[.[]|secrets: inherit|environment:|create-github-app-token/);
    for (const job of Object.keys(w.jobs)) {
      expect(steps(job).flatMap((s) => Object.entries(s.env ?? {})).filter(([, v]) => /token/i.test(String(v)))).toEqual(steps(job).some((s) => s.env?.GH_TOKEN) ? [['GH_TOKEN', '${{ github.token }}']] : []);
    }
  });

  it('`doctor` runs Kanon\'s CLI at the harness\'s pin on `main`, with read permissions only', () => {
    expect(w.jobs.doctor.permissions).toEqual({ actions: 'read', checks: 'read', contents: 'read', issues: 'read' });
    expect(steps('doctor')[0].with).toMatchObject({ ref: 'main', 'persist-credentials': false });
    expect(runs('doctor')).toMatch(/npx --yes --package "github:yedeya-labs\/kanon#\$pins" kanon doctor --json/);
  });

  it('`signal` holds `issues: write` and runs the harness\'s code alone, never Kanon\'s', () => {
    expect(w.jobs.signal.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    expect(w.jobs.signal.needs).toBe('doctor');
    expect(runs('signal')).not.toMatch(/npx|kanon /);
    expect(runs('signal').trim()).toBe('node runner/upgrade-signal.mjs');
    expect(steps('signal')[0].with).toMatchObject({ 'persist-credentials': false });
  });

  it('pins every action to a commit', () => {
    const unpinned = Object.values(w.jobs).flatMap((j) => j.steps.filter((s) => s.uses && !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(s.uses)).map((s) => s.uses));
    expect(unpinned).toEqual([]);
  });
});
