import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initFlagProblems } from '../runner/lib/kanon.mjs';
import { readWorkflows, workflowFiles } from './helpers/workflows.mjs';

/**
 * Who sends telemetry: the harness does, and its scenario repositories don't (harness #11).
 *
 * THE HARNESS SENDS, AS AN ADOPTER THAT OPTS IN. `kanon init --telemetry --upstream-findings
 * sent-with-evidence` wrote `.github/workflows/telemetry.yml`, the collector's caller, and the
 * adoption record says `sent with evidence`. Without the caller, a record that says `sent` or
 * `sent with evidence` sends nothing (`upstream.unsent`); without the bullet, the findings stay
 * drafts. So each is held here.
 *
 * THE SCENARIO REPOSITORIES SEND NOTHING (Kanon plan 0012 §4.2 and §6.2, decision 8). The
 * `kanon.init` verb declines telemetry and sharing, and a scenario installs no collector. Nothing
 * the harness's code passes to `kanon init` may turn either on, and no scenario's starting tree
 * may hold a collector's caller. The runner and the scenarios aren't written yet (plan 0012 step
 * E4), so the scan finds nothing today, and the checks below it hold each spelling it is for.
 */

const ADOPTION = 'docs/qa/adoption.md';
const COLLECTOR = /^yedeya-labs\/kanon\/\.github\/workflows\/telemetry-collect\.yml@([\w.-]+)$/;
const KANON_CALL = /^yedeya-labs\/kanon\/\.github\/workflows\/[\w.-]+\.ya?ml@([\w.-]+)$/;

/**
 * The flags of `kanon init` that turn telemetry or sharing on: `--telemetry`, `--consent yes` or
 * `codes`, and `--upstream-findings sent` or `sent-with-evidence`, each spelled with a space or an
 * `=`, or as a JSON list's next element. `--no-telemetry`, `--consent no` and the other levels
 * are what the scenarios pass, and don't match.
 */
const SENDS = [
  /(?<![\w-])--telemetry(?![\w-])/,
  /(?<![\w-])--consent["'`]?\s*(?:=|,|\s)\s*["'`]?(?:yes|codes)\b/,
  /(?<![\w-])--upstream-findings["'`]?\s*(?:=|,|\s)\s*["'`]?sent\b/,
];
/** A reference to Kanon's telemetry collector, as a caller names it. */
const CALLS_COLLECTOR = /telemetry-collect\.ya?ml/;

/** Every line of `text` that turns telemetry or sharing on, or calls the collector. */
export const sendingLines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => SENDS.some((re) => re.test(l)) || CALLS_COLLECTOR.test(l));

/** Every file under `dir`, recursively, or none when it doesn't exist. */
const filesUnder = (dir) => !existsSync(dir) ? [] : readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

/**
 * What the harness's code passes to a scenario repository: the runner, which runs `kanon.init`;
 * the scenarios, their steps and their starting trees; and the `e2e*.yml` workflows that run them.
 */
const scenarioCode = () => [
  ...filesUnder('runner'),
  ...filesUnder('scenarios'),
  ...workflowFiles().filter((f) => f.startsWith('e2e')).map((f) => join('.github/workflows', f)),
];

/**
 * THE ONE LINE LET THROUGH: the list of flags the validator REFUSES a scenario's `kanon.init`
 * (runner/lib/kanon.mjs), which names `--telemetry` so as to refuse it. The test below holds that
 * a scenario passing it is refused.
 */
const REFUSAL = 'runner/lib/kanon.mjs: export const INIT_REFUSED = [';

/** Every `path: line` in `paths` that would make a scenario repository send. */
const sendingFrom = (paths) => paths.flatMap((p) => sendingLines(readFileSync(p, 'utf8')).map((l) => `${p}: ${l}`)).filter((l) => !l.startsWith(REFUSAL));

describe('the harness sends its telemetry and upstream findings, as an adopter that opts in', () => {
  const docs = readWorkflows();

  it('calls Kanon\'s telemetry collector, at the release the lane callers pin', () => {
    const collectors = Object.entries(docs).flatMap(([f, doc]) => Object.values(doc?.jobs ?? {})
      .filter((job) => COLLECTOR.test(String(job?.uses ?? ''))).map((job) => ({ file: f, ref: COLLECTOR.exec(job.uses)[1] })));
    expect(collectors.map(({ file }) => file)).toEqual(['telemetry.yml']);
    const pins = new Set(Object.values(docs).flatMap((doc) => Object.values(doc?.jobs ?? {}))
      .map((job) => KANON_CALL.exec(String(job?.uses ?? ''))?.[1]).filter(Boolean));
    expect([...pins]).toEqual([collectors[0].ref]);
  });

  it('declares its upstream findings `sent with evidence`, under `## Choices`', () => {
    const text = readFileSync(ADOPTION, 'utf8');
    const choices = text.split(/^## /m).find((s) => s.startsWith('Choices\n')) ?? '';
    expect(choices.split('\n').filter((l) => l.startsWith('- **Upstream findings:**'))).toEqual(['- **Upstream findings:** `sent with evidence`']);
  });
});

describe('the scenario repositories send nothing (plan 0012 §4.2, decision 8)', () => {
  it('no flag the harness\'s code passes to `kanon init` turns telemetry or sharing on, and no scenario installs a collector', () => {
    expect(sendingFrom(scenarioCode())).toEqual([]);
  });

  it('the one line let through refuses the flags it names: a scenario that passes one is refused', () => {
    for (const flag of ['--telemetry', '--consent=yes', '--upstream-findings=sent-with-evidence']) {
      expect(initFlagProblems([flag]), flag).toEqual([expect.stringMatching(/is refused/)]);
    }
  });

  it('catches every spelling of a flag that turns them on, and a collector\'s caller', () => {
    for (const line of [
      'kanon init --json --yes --no-apps --telemetry',
      'kanon init --consent yes',
      'kanon init --consent=codes',
      '["init", "--json", "--consent", "yes"]',
      "args.push('--upstream-findings', 'sent-with-evidence')",
      'kanon init --telemetry --upstream-findings=sent',
      '    uses: yedeya-labs/kanon/.github/workflows/telemetry-collect.yml@{{release}}',
    ]) expect(sendingLines(line), line).toEqual([line.trim()]);
  });

  it('lets through the flags that decline them', () => {
    for (const line of [
      'kanon init --json --yes --no-apps --no-telemetry',
      'kanon init --consent no',
      '["--consent", "no"]',
      'kanon init --upstream-findings drafted',
      "args.push('--upstream-findings', 'filed-here')",
      'kanon init --telemetry-tag run',
    ]) expect(sendingLines(line), line).toEqual([]);
  });
});
