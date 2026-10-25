import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path/posix';
import { describe, expect, it } from 'vitest';
import { environmentJobs, readWorkflows } from './helpers/workflows.mjs';

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

/**
 * The repository-relative paths of the local modules a module's `import` declarations name. Only
 * a declaration at the start of a line counts, so an import quoted in a string doesn't.
 */
export const importsOf = (text, file) => [...text.matchAll(/^import\b[^;'"]*?['"](\.{1,2}\/[^'"]+)['"]/gm)]
  .map((m) => join(dirname(file), m[1]));

/** The local modules the given files import, followed through the modules they import in turn. */
const importedBy = (files) => {
  const seen = new Set();
  const visit = (file) => importsOf(readFileSync(file, 'utf8'), file).forEach((m) => {
    if (!seen.has(m) && !files.includes(m)) { seen.add(m); visit(m); }
  });
  files.forEach(visit);
  return [...seen];
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
/**
 * The guard tests, which hold the line around the driver key (#13): a pull request that loosens
 * one is as dangerous as one that loosens a workflow it guards.
 */
const GUARDS = ['tests/workflows.test.mjs', 'tests/escalation-paths.test.mjs'];
/** The helpers the guard tests import: weakening one weakens the tests. */
const GUARD_HELPERS = importedBy(GUARDS);
/**
 * Every root file Vitest reads its configuration from, which could exclude a guard test:
 * Vitest 5 takes `vitest.config`, else `vite.config`, in six extensions (its `CONFIG_NAMES` and
 * `CONFIG_EXTENSIONS`).
 */
const VITEST_CONFIG = ['vitest.config', 'vite.config'].flatMap((name) => ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].map((ext) => name + ext));
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

  it('marks every workflow that reads an environment\'s key `always`', () => {
    // Not vacuous: the `-run` workflows read the driver's key from `e2e`, `e2e.yml` the Reporter's from `e2e-report`.
    expect(ENVIRONMENT_READERS.length).toBeGreaterThan(1);
    expect(notAlways(entries, ENVIRONMENT_READERS)).toEqual([]);
  });

  it('marks the guard tests themselves `always`: the workflow test and this one', () => {
    expect(notAlways(entries, GUARDS)).toEqual([]);
  });

  it('marks every helper the guard tests import `always`', () => {
    // Not vacuous: both guard tests import `tests/helpers/workflows.mjs`.
    expect(GUARD_HELPERS).toContain('tests/helpers/workflows.mjs');
    expect(notAlways(entries, GUARD_HELPERS)).toEqual([]);
  });

  it('marks every root Vitest configuration `always`, which could exclude a guard test', () => {
    expect(notAlways(entries, VITEST_CONFIG)).toEqual([]);
  });

  it('leaves the other tests and their shared stubs green', () => {
    // The `always` patterns name the guards, not `tests/`: a routine test change stays the Merger's.
    expect(notAlways(entries, ['tests/runner.test.mjs', 'tests/helpers/stubs.mjs', 'tests/vitest.config.mjs'])).toHaveLength(3);
  });
});

describe('the check catches what it is for', () => {
  const file = (...bullets) => ['# Escalation paths', '', '## Escalation paths', '', ...bullets, '', '## Pipeline code', '', '- `scripts/` — x', ''].join('\n');
  const pair = '.github/workflows/e2e-act-run.yml';

  it('a pattern without `always`, or with only a category, is not `always`', () => {
    expect(notAlways(parseEntries(file('- `^\\.github/workflows/e2e` `pipeline` — the pairs')), [pair])).toEqual([pair]);
    expect(notAlways(parseEntries(file('- `^\\.github/workflows/e2e` — the pairs')), [pair])).toEqual([pair]);
    expect(notAlways(parseEntries(file('- `^\\.github/workflows/e2e` `pipeline` `always` — the pairs')), [pair])).toEqual([]);
  });

  it('a pattern dropped, or one listed under another heading, covers nothing', () => {
    expect(notAlways(parseEntries(file('- `^runner/` `always` — the runner')), [pair])).toEqual([pair]);
    expect(notAlways(parseEntries(file().replace('`scripts/` — x', '`^\\.github/workflows/e2e` `always` — x')), [pair])).toEqual([pair]);
  });

  it('the import reader finds every local module a declaration imports, and nothing else', () => {
    const text = [
      "import { a } from './helpers/a.mjs';", "import '../b.mjs';", 'import {', '  c,', "} from './c.mjs';",
      "import { d } from 'vitest';", "import { e } from 'node:fs';", "const f = \"import './f.mjs'\";",
    ].join('\n');
    expect(importsOf(text, 'tests/x.test.mjs')).toEqual(['tests/helpers/a.mjs', 'b.mjs', 'tests/c.mjs']);
  });

  it('a bullet that isn\'t an entry fails by name rather than being skipped', () => {
    expect(() => parseEntries(file('- ^runner/ always — the runner'))).toThrow(/isn't an entry/);
  });
});
