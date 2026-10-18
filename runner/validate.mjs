#!/usr/bin/env node
// The scenario validator (Kanon plan 0012 §4, step E3). A scenario is data: a directory
// `scenarios/<scenario>/` holding `scenario.json`, a `start/` tree laid down as the scenario
// repository's first commit, and `steps.json`, up to three phases, each a `kanon` segment then an
// `act` segment of verbs from the closed vocabulary. The runner (E4) reads scenarios only
// through `loadScenario`, so a scenario it runs has passed every rule here:
//
//   - scenario.json, field by field, as §4.1 states it;
//   - start/ holds regular files only, with no substitution but `{{release}}` and `{{repository}}`;
//   - steps.json needs at most three phases (§5.2), and each step's verb is in the vocabulary, in
//     its kind of segment, with the arguments it takes and a `deadline` where it waits (§4.2, §10);
//   - an expectation names only a JSON field, a finding id or a known marker, and compares it to
//     a value: never free text to match, never a field that holds it (§4.3);
//   - `expect.api` reads only the scenario repository's own API;
//   - steps.json takes two substitutions, each in one place: `{{repository}}` in `expect.api`'s
//     path, and `{{release}}` in a `fields` entry's `equals` of `expect.init` and `expect.doctor`.
//
//   node runner/validate.mjs [<scenario dir>...]   (default: every directory under scenarios/)
// prints each problem and exits 1 when there is one.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEADLINE, bool, checkArgs, int, str, strs } from './lib/args.mjs';
import { VOCABULARY } from './vocabulary.mjs';

/** At most three phases, each a `kanon` job and then an `act` job (§5.2). */
export const MAX_PHASES = 3;
export const SEGMENTS = /** @type {const} */ (['kanon', 'act']);
/** The two substitutions `start/` takes (§4.1). */
export const SUBSTITUTIONS = Object.freeze(['release', 'repository']);
/** `{{name}}`, but not a workflow's `${{ expression }}`. */
const SUBSTITUTION = /(?<!\$)\{\{([^{}]*)\}\}/g;

/** scenario.json's fields (§4.1). */
export const SCENARIO_FIELDS = Object.freeze({
  id: str({ required: true, pattern: /^[a-z0-9-]{1,40}$/, hint: 'lowercase, digits and hyphens, at most 40 characters' }),
  family: str({ required: true, enum: ['lane', 'install', 'doctor', 'upgrade', 'deploy'] }),
  tier: str({ required: true, enum: ['none', 'model'] }),
  gate: bool({ required: true }),
  apps: strs({ required: true, items: { enum: ['author', 'judge', 'releaser'] } }),
  claude: str({ required: true, enum: ['none', 'subscription'] }),
  deadlineMinutes: int({ required: true, min: 1, max: 120 }),
});

const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The problems of a scenario.json, for the directory named `dirName`.
 * @param {unknown} s @param {string} dirName
 */
export function validateScenarioJson(s, dirName) {
  if (!isObject(s)) return ['scenario.json must be an object'];
  const o = /** @type {Record<string, unknown>} */ (s);
  const p = checkArgs(SCENARIO_FIELDS, o, '', (k) => `\`${k}\` is not a field of scenario.json (Kanon plan 0012 §4.1)`);
  if (typeof o.id === 'string' && o.id !== dirName) p.push(`\`id\` \`${o.id}\` must be the directory's name, \`${dirName}\``);
  return p;
}

/** The substitutions in `text` that aren't the two. @param {string} text */
const strangers = (text) => [...text.matchAll(SUBSTITUTION)].map((m) => m[0]).filter((m) => !SUBSTITUTIONS.includes(m.slice(2, -2)));

/**
 * The problems of a `start/` tree: anything but a regular file or a directory, a substitution
 * other than the two in a path or a text file, or no file at all. A file with a NUL byte is
 * binary, and copied as it is.
 * @param {string} dir
 */
export function validateStart(dir) {
  const p = [];
  let files = 0;
  const walk = (/** @type {string} */ here) => {
    for (const name of readdirSync(here)) {
      const full = join(here, name);
      const rel = relative(dir, full);
      const st = lstatSync(full);
      for (const s of strangers(rel)) p.push(`start/${rel}: the substitution ${s} in its path is not one of the two, {{release}} and {{repository}}`);
      if (st.isDirectory()) walk(full);
      else if (!st.isFile()) p.push(`start/${rel}: not a regular file or a directory (start/ is data, copied as it is)`);
      else {
        files++;
        const bytes = readFileSync(full);
        if (bytes.includes(0)) continue;
        for (const s of new Set(strangers(bytes.toString('utf8')))) p.push(`start/${rel}: the substitution ${s} is not one of the two, {{release}} and {{repository}}`);
      }
    }
  };
  try {
    if (!lstatSync(dir).isDirectory()) return ['start/ must be a directory'];
  } catch {
    return [`start/ is missing (${dir})`];
  }
  walk(dir);
  if (files === 0) p.push('start/ holds no file: it becomes the scenario repository\'s first commit');
  return p;
}

const KIND_RULE = {
  kanon: (/** @type {string} */ v) => `\`${v}\` runs Kanon's code, so it belongs only in a \`kanon\` segment`,
  act: (/** @type {string} */ v) => `\`${v}\` writes to GitHub with the harness's code, so it belongs only in an \`act\` segment`,
};
const REFERS = { prs: 'pull request', issues: 'issue', runs: 'run' };

/**
 * Every string in a value, with where it sits: the step's key, then each key below it, a list's
 * index left out (`fields.equals` for a `fields` entry's `equals`, in a list or not).
 * @param {unknown} v @param {string} key @returns {Array<[string, string]>}
 */
const strings = (v, key) => (typeof v === 'string' ? [[key, v]] : Array.isArray(v) ? v.flatMap((x) => strings(x, key)) : isObject(v) ? Object.entries(/** @type {object} */ (v)).flatMap(([k, x]) => strings(x, `${key}.${k}`)) : []);

/**
 * The problems of a steps.json.
 * @param {unknown} steps
 * @param {{ scenarioDir?: string }} [scope] the scenario's directory, for the checks that read it
 */
export function validateSteps(steps, scope = {}) {
  if (!isObject(steps)) return ['steps.json must be an object with `phases`'];
  const o = /** @type {Record<string, unknown>} */ (steps);
  const p = Object.keys(o).filter((k) => k !== 'phases').map((k) => `\`${k}\` is not a key of steps.json: it holds \`phases\` alone`);
  const phases = o.phases;
  if (!Array.isArray(phases)) return [...p, '`phases` must be a list'];
  if (phases.length === 0) p.push('steps.json needs at least one phase');
  if (phases.length > MAX_PHASES) p.push(`steps.json needs ${phases.length} phases, more than three phases: a scenario runs at most three, each a \`kanon\` job then an \`act\` job (Kanon plan 0012 §5.2)`);

  /** What earlier steps made, by kind. @type {Record<string, Set<string>>} */
  const made = { prs: new Set(), issues: new Set(), runs: new Set(), documents: new Set() };
  let applies = 0;
  /** `bootstrap.end`'s moves so far. @type {Set<string>} */
  const ends = new Set();
  phases.forEach((phase, i) => {
    if (!isObject(phase)) return p.push(`phases[${i}] must be an object with a \`kanon\` and an \`act\` segment`);
    for (const k of Object.keys(phase)) if (!SEGMENTS.includes(/** @type {any} */ (k))) p.push(`phases[${i}]: \`${k}\` is not a segment: a phase is a \`kanon\` segment then an \`act\` segment`);
    let count = 0;
    for (const segment of SEGMENTS) {
      const list = phase[segment];
      if (list === undefined) { p.push(`phases[${i}]: its \`${segment}\` segment is missing (it may be empty)`); continue; }
      if (!Array.isArray(list)) { p.push(`phases[${i}].${segment} must be a list of steps`); continue; }
      count += list.length;
      list.forEach((step, j) => {
        const where = `phases[${i}].${segment}[${j}]`;
        if (!isObject(step) || typeof step.verb !== 'string') return p.push(`${where}: a step is an object that names its \`verb\``);
        const errors = stepProblems(step, segment, made, scope);
        if (step.verb === 'repo.apply' && ++applies > 2) errors.push('`repo.apply` runs at most twice for each kept init document: the first applies the settings init leaves, the second the `Lane check` rule');
        if ((VOCABULARY[step.verb]?.defines?.(step) ?? []).some(([kind, name]) => kind === 'documents' && name === 'init')) applies = 0;
        if (step.verb === 'bootstrap.end' && typeof step.move === 'string') {
          if (ends.has(step.move)) errors.push(`\`${step.move}\` runs once`);
          if (step.move === 'approval' && !ends.has('record')) errors.push('`approval` has no earlier `record`: once the ruleset requires an approval, the record can\'t reach the default branch without one');
          ends.add(step.move);
        }
        for (const e of errors) p.push(`${where} \`${step.verb}\`: ${e}`);
      });
    }
    if (count === 0) p.push(`phases[${i}] has no step`);
  });
  return p;
}

/**
 * The problems of one step in a segment, given what earlier steps made (which it adds to).
 * @param {Record<string, any>} step @param {'kanon' | 'act'} segment
 * @param {Record<string, Set<string>>} made @param {{ scenarioDir?: string }} scope
 */
function stepProblems(step, segment, made, scope) {
  const v = VOCABULARY[step.verb];
  if (!v) return [`unknown verb \`${step.verb}\`: the vocabulary is closed (Kanon plan 0012 §4.2); a verb is added in a pull request, with its test`];
  const p = [];
  if (v.kind !== 'read' && v.kind !== segment) p.push(KIND_RULE[/** @type {'kanon' | 'act'} */ (v.kind)](step.verb));

  const { verb: _, ...args } = step;
  const specs = v.waits ? { ...v.args, deadline: DEADLINE } : v.args;
  const unknown = step.verb.startsWith('expect.')
    ? (/** @type {string} */ k) => `\`${k}\` is not something an expectation may name: an expectation names only a JSON field, a finding id or a known marker, and compares it to a value, never free text to match (Kanon plan 0012 §4.3)`
    : undefined;
  if (v.waits && args.deadline === undefined) p.push(`\`${step.verb}\` waits, so it needs a \`deadline\` in minutes (Kanon plan 0012 §10)`);
  p.push(...checkArgs(specs, args, '', unknown).filter((e) => !(v.waits && e === '`deadline` is missing')));
  if (v.check) p.push(...v.check(step, scope));

  for (const [key, text] of Object.entries(args).flatMap(([k, x]) => strings(x, k))) {
    for (const [s, name] of text.matchAll(SUBSTITUTION)) {
      if (!(v.substitutes?.[key] ?? []).includes(name)) p.push(`\`${key}\`: the substitution ${s} is not taken here: steps.json takes \`{{repository}}\` in \`expect.api\`'s path, \`{{release}}\` in a \`fields\` entry's \`equals\` of \`expect.init\` and \`expect.doctor\`, and nothing else`);
    }
  }

  for (const [key, spec] of Object.entries(specs)) {
    const name = args[key];
    if (spec.ref && typeof name === 'string' && !made[spec.ref].has(name)) p.push(`\`${name}\` names no ${REFERS[/** @type {'prs'} */ (spec.ref)]} an earlier step made`);
  }
  for (const [kind, name] of v.uses?.(step) ?? []) {
    if (!made[kind].has(name)) p.push(`it reads the document of an earlier \`kanon.${name}\` or \`kanon.at\`, and there is no earlier \`kanon.${name}\``);
  }
  for (const [key, spec] of Object.entries(specs)) if (spec.defines && typeof args[key] === 'string') made[spec.defines].add(args[key]);
  for (const [kind, name] of v.defines?.(step) ?? []) made[kind].add(name);
  return p;
}

/** Reads a JSON file, or returns the problem. @param {string} path @param {string} name */
const readJson = (path, name) => {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { problem: `${name}: missing` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { problem: `${name}: not JSON (${/** @type {Error} */ (e).message})` };
  }
};

/** The problems of a scenario directory, each prefixed with the file it is in. @param {string} dir */
export function validateScenarioDir(dir) {
  const p = [];
  const scenario = readJson(join(dir, 'scenario.json'), 'scenario.json');
  if (scenario.problem) p.push(scenario.problem);
  else p.push(...validateScenarioJson(scenario.value, basename(dir)).map((e) => `scenario.json: ${e}`));
  p.push(...validateStart(join(dir, 'start')));
  const steps = readJson(join(dir, 'steps.json'), 'steps.json');
  if (steps.problem) p.push(steps.problem);
  else {
    p.push(...validateSteps(steps.value, { scenarioDir: dir }).map((e) => `steps.json: ${e}`));
    const verbs = JSON.stringify(steps.value);
    if (verbs.includes('"register.write"') && Array.isArray(scenario.value?.apps) && scenario.value.apps.length === 0) {
      p.push('steps.json: `register.write` writes the rows of the scenario\'s test Apps, and scenario.json\'s `apps` names none');
    }
  }
  return p;
}

/** Every scenario directory under `root`, sorted. @param {string} [root] */
export const scenarioDirs = (root = 'scenarios') => {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => lstatSync(join(root, n)).isDirectory()).sort().map((n) => join(root, n));
};

/**
 * A scenario, as the runner reads it: validated, or refused with every problem.
 * @param {string} dir
 * @returns {{ scenario: any, steps: any, dir: string }}
 */
export function loadScenario(dir) {
  const problems = validateScenarioDir(dir);
  if (problems.length) throw new Error(`${dir} is not a valid scenario:\n${problems.map((x) => `  - ${x}`).join('\n')}`);
  return { dir, scenario: JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')), steps: JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8')) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : scenarioDirs();
  let bad = 0;
  for (const dir of dirs) {
    const problems = validateScenarioDir(dir);
    if (problems.length) bad++;
    console.log(problems.length ? `${dir}: ${problems.length} problem(s)\n${problems.map((x) => `  - ${x}`).join('\n')}` : `${dir}: valid`);
  }
  if (!dirs.length) console.log('No scenario directory under scenarios/.');
  process.exitCode = bad ? 1 : 0;
}
