import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { environmentJobs, readWorkflows, workflowFiles } from './helpers/workflows.mjs';

/**
 * The harness's escalation file (`K-LAYOUT-8`) keeps everything that runs with the driver's key
 * on the Owner's side, by pattern, so the first pull request that adds a matching file is
 * already the Owner's to merge (Kanon plan 0012 §3, decision 17).
 *
 * The entries are read the way Kanon's parser reads them (`scripts/lib/escalation-paths.mjs`):
 * a bullet under `## Escalation paths`, the pattern in backticks, optionally a category, then
 * optionally `always`, an em dash and the reason. `lane-check` parses the same file with Kanon's
 * own reader on every pull request, so a malformed entry fails there too.
 */

const FILE = 'docs/qa/escalation-paths.md';
const ENTRY = /^`([^`]+)`(?:\s+`([^`]+)`)?(?:\s+`([^`]+)`)?\s+—\s+(\S.*)$/;

/** The `## Escalation paths` entries of an escalation file's text. */
export const parseEntries = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf('## Escalation paths');
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).flatMap((line) => {
    const bullet = /^- (.*)$/.exec(line);
    if (!bullet) return [];
    const entry = ENTRY.exec(bullet[1].trim());
    if (!entry) throw new Error(`${FILE}: \`${line}\` isn't an entry`);
    const spans = [entry[2], entry[3]].filter((s) => s !== undefined);
    const literal = /^\/(.+)\/(i?)$/.exec(entry[1]);
    return [{
      source: entry[1],
      pattern: literal ? new RegExp(literal[1], literal[2]) : new RegExp(entry[1]),
      always: spans.at(-1) === 'always',
      reason: entry[4].trim(),
    }];
  });
};

/** The paths no `always` entry matches. */
export const notAlways = (entries, paths) => paths.filter((p) => !entries.some((e) => e.always && e.pattern.test(p)));

const entries = parseEntries(readFileSync(FILE, 'utf8'));

/**
 * What must stay the Owner's. The runner and the janitor aren't written yet (plan 0012 step E4):
 * these are paths they will have, so the patterns hold before the first file lands.
 */
const RUNNER = ['runner/run.mjs', 'runner/verbs/pr-open.mjs', 'runner/github.mjs', 'runner/lib/artifact.mjs'];
const JANITOR = ['janitor/janitor.mjs', 'janitor/lib/age.mjs'];
const E2E = [
  'e2e.yml', 'e2e-janitor.yml',
  'e2e-kanon-run.yml', 'e2e-kanon-job.yml', 'e2e-act-run.yml', 'e2e-act-job.yml',
  'e2e-janitor-run.yml', 'e2e-janitor-job.yml', 'e2e-model-key-run.yml', 'e2e-model-key-job.yml',
  'e2e-a-pair-added-later-run.yml', 'e2e-a-pair-added-later-job.yml',
].map((f) => `.github/workflows/${f}`);
const PROBES = [
  ...workflowFiles().filter((f) => f.startsWith('probe-')),
  'probe-99-a-probe-added-later.yml',
].map((f) => `.github/workflows/${f}`);
/** Every workflow that names an environment reads that environment's keys. */
const ENVIRONMENT_READERS = [...new Set(environmentJobs(readWorkflows()).map(({ file }) => `.github/workflows/${file}`))];

describe('the escalation paths keep what runs with the driver key the Owner\'s', () => {
  it('reads the file, and every entry gives its reason', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e.reason, e.source).not.toBe('');
  });

  it('marks the runner\'s modules `always`, by pattern', () => {
    expect(notAlways(entries, RUNNER)).toEqual([]);
  });

  it('marks the janitor\'s modules `always`, by pattern', () => {
    expect(notAlways(entries, JANITOR)).toEqual([]);
  });

  it('marks the `e2e*.yml` workflows and their `-run` and `-job` pairs `always`, by pattern', () => {
    expect(notAlways(entries, E2E)).toEqual([]);
  });

  it('marks the `probe-*.yml` workflows `always`, by pattern', () => {
    expect(PROBES.length).toBeGreaterThan(1);
    expect(notAlways(entries, PROBES)).toEqual([]);
  });

  it('marks every workflow that reads an environment\'s key `always`', () => {
    // Not vacuous: the probes read the driver's key from `e2e`, probe 13 the Reporter's from `e2e-report`.
    expect(ENVIRONMENT_READERS.length).toBeGreaterThan(1);
    expect(notAlways(entries, ENVIRONMENT_READERS)).toEqual([]);
  });

});

describe('the check catches what it is for', () => {
  const file = (...bullets) => ['# Escalation paths', '', '## Escalation paths', '', ...bullets, '', '## Pipeline code', '', '- `scripts/` — x', ''].join('\n');
  const probe = '.github/workflows/probe-01-repo-lifecycle.yml';

  it('a pattern without `always`, or with only a category, is not `always`', () => {
    expect(notAlways(parseEntries(file('- `^\\.github/workflows/probe-` `pipeline` — the probes')), [probe])).toEqual([probe]);
    expect(notAlways(parseEntries(file('- `^\\.github/workflows/probe-` — the probes')), [probe])).toEqual([probe]);
    expect(notAlways(parseEntries(file('- `^\\.github/workflows/probe-` `pipeline` `always` — the probes')), [probe])).toEqual([]);
  });

  it('a pattern dropped, or one listed under another heading, covers nothing', () => {
    expect(notAlways(parseEntries(file('- `^runner/` `always` — the runner')), [probe])).toEqual([probe]);
    expect(notAlways(parseEntries(file().replace('`scripts/` — x', '`^\\.github/workflows/probe-` `always` — x')), [probe])).toEqual([probe]);
  });

  it('a bullet that isn\'t an entry fails by name rather than being skipped', () => {
    expect(() => parseEntries(file('- ^runner/ always — the runner'))).toThrow(/isn't an entry/);
  });
});
