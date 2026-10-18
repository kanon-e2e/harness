import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { poll } from '../runner/lib/poll.mjs';
import { KNOWN_MARKERS, markerById } from '../runner/lib/markers.mjs';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { fakeClock } from './helpers/stubs.mjs';

/**
 * The step vocabulary as a whole (Kanon plan 0012 §4.2): a closed set, each verb implemented
 * once, in one kind of segment, with a deadline and a backoff poll where it waits (§10), and
 * Kanon's code run only at the release under test, fetched as an adopter fetches it.
 */

/** §4.2's table, with `repo.apply` (decision 23 (b)), and the deploy rehearsal's three (E5). */
const PLAN = [
  'kanon.init', 'repo.apply', 'kanon.doctor', 'kanon.at', 'register.write', 'pins.move', 'files.commit',
  'pr.open', 'pr.label', 'pr.merge', 'issue.open', 'issue.label', 'workflow.dispatch', 'release.cut',
  'deployment.await-approval', 'run.await', 'expect.init', 'expect.doctor', 'expect.run', 'expect.check',
  'expect.issue', 'expect.pr', 'expect.artifact', 'expect.api',
  'environment.create', 'ruleset.tags', 'issue.await',
];

const verbs = Object.values(VOCABULARY);
const source = (v) => readFileSync(new URL(`../runner/verbs/${v.verb.replace(/\./g, '-')}.mjs`, import.meta.url), 'utf8');

describe('the vocabulary is §4.2\'s closed set, each verb once', () => {
  it('holds exactly the plan\'s verbs', () => {
    expect(Object.keys(VOCABULARY).sort()).toEqual([...PLAN].sort());
  });

  it('implements each verb once, in a module of its own named for it', () => {
    const modules = readdirSync(new URL('../runner/verbs/', import.meta.url)).filter((f) => f.endsWith('.mjs')).sort();
    expect(modules).toEqual(PLAN.map((v) => `${v.replace(/\./g, '-')}.mjs`).sort());
    for (const v of verbs) expect(typeof v.run, v.verb).toBe('function');
  });

  it('gives each verb its own unit test, a `describe` named for it', () => {
    const tests = readdirSync(new URL('./', import.meta.url)).filter((f) => /^verbs-.*\.test\.mjs$/.test(f))
      .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
    for (const v of PLAN) expect(tests, v).toContain(`describe('${v}'`);
  });
});

describe('each verb belongs to one kind of segment (§4.2)', () => {
  const kindOf = (v) => VOCABULARY[v].kind;

  it('the kanon.*, register.write and pins.move verbs run Kanon\'s code: kanon segments only', () => {
    expect(PLAN.filter((v) => kindOf(v) === 'kanon').sort()).toEqual(['kanon.at', 'kanon.doctor', 'kanon.init', 'pins.move', 'register.write']);
  });

  it('the expect.*, run.await and issue.await verbs only read: either segment', () => {
    expect(PLAN.filter((v) => kindOf(v) === 'read').sort()).toEqual(PLAN.filter((v) => v.startsWith('expect.') || v === 'run.await' || v === 'issue.await').sort());
  });

  it('every other verb writes to GitHub with the harness\'s code, repo.apply included: act segments only', () => {
    expect(PLAN.filter((v) => kindOf(v) === 'act').sort()).toEqual(
      ['repo.apply', 'files.commit', 'pr.open', 'pr.label', 'pr.merge', 'issue.open', 'issue.label', 'workflow.dispatch', 'release.cut', 'deployment.await-approval',
        'environment.create', 'ruleset.tags'].sort());
  });

  it('no verb outside a kanon segment runs Kanon\'s code: no npx, no Kanon module', () => {
    for (const v of verbs.filter((x) => x.kind !== 'kanon')) {
      const text = source(v);
      expect(text, v.verb).not.toMatch(/npx|lib\/kanon\.mjs|kanonRoot/);
    }
  });
});

describe('every verb that waits takes a deadline, and polls (§10)', () => {
  it('the waiting verbs', () => {
    expect(verbs.filter((v) => v.waits).map((v) => v.verb).sort()).toEqual([
      'deployment.await-approval', 'expect.api', 'expect.artifact', 'expect.check', 'expect.issue', 'expect.pr',
      'expect.run', 'issue.await', 'pr.merge', 'release.cut', 'run.await',
    ]);
  });

  it('no verb sleeps on its own: each waits only through the poll', () => {
    for (const v of verbs) expect(source(v), v.verb).not.toMatch(/setTimeout|\.sleep\(/);
    for (const v of verbs.filter((x) => x.waits)) expect(source(v), v.verb).toMatch(/\bpoll\(/);
  });

  it('backs off from 2 to 30 seconds, never a fixed sleep, until the predicate holds', async () => {
    const clock = fakeClock();
    let tries = 0;
    const value = await poll({ now: clock.now, sleep: clock.sleep }, 10, async () => (++tries < 8 ? { ok: false, why: 'not yet' } : { ok: true, value: 'done' }));
    expect(value).toBe('done');
    expect(clock.sleeps).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('fails, not hangs, when the deadline passes, naming the last thing it saw, and never sleeps past it', async () => {
    const clock = fakeClock();
    const start = clock.now();
    await expect(poll({ now: clock.now, sleep: clock.sleep }, 1, async () => ({ ok: false, why: 'the run is queued' })))
      .rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(/deadline of 1 minute.*the run is queued/) });
    expect(clock.now() - start).toBe(60_000);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(30_000);
  });

  it('asks once more at the deadline, so a predicate that holds then still passes', async () => {
    const clock = fakeClock();
    const end = clock.now() + 60_000;
    expect(await poll({ now: clock.now, sleep: clock.sleep }, 1, async () => (clock.now() >= end ? { ok: true, value: 1 } : { ok: false, why: 'no' }))).toBe(1);
  });
});

describe('every verb that runs Kanon\'s code runs it at the release under test, fetched as an adopter fetches it', () => {
  it('each kanon-segment verb names `npx --yes --package github:yedeya-labs/kanon#<release>` and nothing else to run Kanon', () => {
    for (const v of verbs.filter((x) => x.kind === 'kanon')) expect(source(v), v.verb).toMatch(/lib\/kanon\.mjs/);
    const lib = readFileSync(new URL('../runner/lib/kanon.mjs', import.meta.url), 'utf8');
    expect(lib).toContain("'--yes', '--package', `github:${KANON}#${release}`");
  });
});

describe('the harness\'s list of known markers (§4.3)', () => {
  it('holds the release-PR guard\'s marker and the role markers, as Kanon writes them', () => {
    const sha = 'a'.repeat(40);
    expect(markerById('release-pr-guard').test(`<!-- kanon-release-pr-guard ${sha} -->\n**This release PR is stale…**`)).toBe(true);
    expect(markerById('role:reviewer').test('**Reviewer** <!-- kanon:role=reviewer -->')).toBe(true);
    expect(markerById('role:reviewer').test('**Implementer** <!-- kanon:role=implementer -->')).toBe(false);
    expect(markerById('role:reviewer').test('the word kanon:role=reviewer, not in a comment')).toBe(false);
  });

  it('holds only Kanon\'s hidden HTML markers, each with where Kanon writes it, and no free text', () => {
    expect(KNOWN_MARKERS.length).toBeGreaterThan(1);
    expect(new Set(KNOWN_MARKERS.map((m) => m.id)).size).toBe(KNOWN_MARKERS.length);
    for (const m of KNOWN_MARKERS) {
      expect(m.id, m.id).toMatch(/^[a-z0-9:-]+$/);
      expect(m.pattern, m.id).toMatch(/^<!--/);
      expect(m.pattern, m.id).toMatch(/kanon/);
      expect(m.pattern, m.id).toMatch(/-->$/);
      expect(m.writtenBy, m.id).toMatch(/yedeya-labs\/kanon/);
    }
  });

  it('is data under runner/, so a change to it is the Owner\'s to merge', () => {
    expect(JSON.parse(readFileSync(new URL('../runner/known-markers.json', import.meta.url), 'utf8')).markers.length).toBe(KNOWN_MARKERS.length);
  });
});

describe('the docs list the vocabulary as it is', () => {
  /** The rows of the first table in scenarios/README.md: verb, segment kind, waits. */
  const rows = () => {
    const text = readFileSync(new URL('../scenarios/README.md', import.meta.url), 'utf8');
    return text.split('\n').filter((l) => /^\| `[a-z.-]+` \|/.test(l)).map((l) => {
      const c = l.split('|').slice(1, -1).map((x) => x.trim());
      return { verb: c[0].replace(/`/g, ''), kind: c[2].replace(/`/g, ''), waits: c[3] };
    });
  };

  it('scenarios/README.md has one row per verb, with its segment kind and whether it waits', () => {
    const table = rows();
    expect(table.map((r) => r.verb).sort()).toEqual([...PLAN].sort());
    const word = { kanon: 'kanon', act: 'act', read: 'either' };
    for (const r of table) {
      const v = VOCABULARY[r.verb];
      expect(r.kind, r.verb).toBe(word[v.kind]);
      expect(r.waits, r.verb).toBe(v.waits ? 'yes' : 'no');
    }
  });

  it('README.md lists each verb with its segment kind', () => {
    const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const v of PLAN) expect(text, v).toContain(`\`${v}\``);
    expect(text).toContain('runner/known-markers.json');
  });
});
