// How a verb runs Kanon's code (Kanon plan 0012 §4.2): at the release under test, or the one
// `kanon.at` names, fetched as an adopter fetches it, `npx --yes --package
// github:yedeya-labs/kanon#<release> kanon …`, in the `kanon` job's own clone. Only the `kanon`
// segment's verbs import this module; an `act` verb that did would run Kanon's code with the
// `act` job's wide token, which the vocabulary's test refuses.

import { dirname } from 'node:path';

import { api } from './gh.mjs';

export const KANON = 'yedeya-labs/kanon';
/** An exact Kanon release, stable or candidate (Kanon's scripts/move-pins.mjs). */
export const RELEASE = /^(?:candidate-)?v\d+\.\d+\.\d+$/;
/** A release a step names: `previous`, `previous-1` or an exact release (`resolveRelease`). */
export const NAMED_RELEASE = /^(?:previous|previous-1|(?:candidate-)?v\d+\.\d+\.\d+)$/;

/**
 * `npx`'s arguments that fetch Kanon at `release`, as an adopter fetches it.
 * @param {string} release
 */
export const npxPackage = (release) => {
  if (!RELEASE.test(release)) throw new Error(`\`${release}\` is not an exact Kanon release (vX.Y.Z or candidate-vX.Y.Z)`);
  return ['--yes', '--package', `github:${KANON}#${release}`];
};

/**
 * @typedef {{ exec: (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ status: number, stdout: string, stderr: string }>, clone: string, state: any }} KanonContext
 */

/**
 * Runs `kanon <args>` at `release` in the clone, and returns its exit code and its JSON document.
 * A run that prints no document fails by name; a document with any status is kept, for the
 * expectation to hold.
 * @param {KanonContext} ctx @param {string} release @param {string[]} args
 */
export async function runKanon(ctx, release, args) {
  const r = await ctx.exec('npx', [...npxPackage(release), 'kanon', ...args], { cwd: ctx.clone });
  let document;
  try {
    document = JSON.parse(String(r.stdout));
  } catch {
    document = null;
  }
  if (document === null || typeof document !== 'object' || typeof document.schema !== 'string') {
    throw new Error(`kanon ${args[0]} at ${release} printed no JSON document (exit ${r.status}): ${String(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  return { release, exit: r.status, document };
}

/**
 * Keeps a command's document in the run's state, for `expect.init`, `expect.doctor` and `repo.apply`.
 * A new `init` document starts `repo.apply`'s count again: each gets a settings call and a
 * `Lane check` call, so an upgrade applies what the new release's `init` names.
 * @param {KanonContext} ctx @param {'init' | 'doctor'} slot @param {{ release: string, exit: number, document: any }} kept
 */
export const keep = (ctx, slot, kept) => {
  ctx.state.documents = { ...ctx.state.documents, [slot]: kept };
  if (slot === 'init') delete ctx.state.repoApply;
};

/** What `kanon init` always runs with: JSON, no questions, no Apps, telemetry and sharing declined (decision 8). */
export const INIT_FIXED = ['--json', '--yes', '--no-apps', '--consent', 'no'];

/**
 * The flags a scenario may not give `kanon init`: those `INIT_FIXED` sets, and those that would
 * undo it (asking for the Apps, sending telemetry or findings, a dry run, the usage text).
 */
export const INIT_REFUSED = ['--json', '--yes', '--no-apps', '--create-apps', '--consent', '--telemetry', '--no-telemetry', '--upstream-findings', '--dry-run', '--help'];

/** A flag of `kanon init`'s, as a scenario writes it: `--flag` or `--flag=value`. */
export const INIT_FLAG = /^--[a-z][a-z0-9-]*(?:=.+)?$/;

/** The problems of a scenario's `kanon init` flags. @param {unknown} flags */
export const initFlagProblems = (flags) => {
  if (flags === undefined) return [];
  if (!Array.isArray(flags)) return ['`flags` must be a list'];
  return flags.flatMap((f) => {
    if (typeof f !== 'string' || !INIT_FLAG.test(f)) return [`each of \`flags\` is written \`--flag\` or \`--flag=value\`, not \`${f}\``];
    const name = f.split('=')[0];
    return INIT_REFUSED.includes(name) ? [`the flag \`${name}\` is refused: kanon.init always runs \`${INIT_FIXED.join(' ')}\``] : [];
  });
};

/** `kanon init`'s arguments for a scenario's flags. @param {string[]} [flags] */
export const initArgs = (flags = []) => ['init', ...INIT_FIXED, ...flags];

/** `kanon doctor`'s arguments, checking against `to` when given. @param {string | null} [to] */
export const doctorArgs = (to = null) => ['doctor', '--json', ...(to ? ['--to', to] : [])];

/**
 * The root of Kanon's package at `release`, as `npx` fetched it: where its `kanon` bin, which is
 * `cli/kanon.mjs`, resolves to. For the verbs that run a file of the release other than the CLI.
 * @param {KanonContext} ctx @param {string} release
 */
export async function kanonRoot(ctx, release) {
  const r = await ctx.exec('npx', [...npxPackage(release), '-c', 'readlink -f "$(command -v kanon)"'], { cwd: ctx.clone });
  const bin = String(r.stdout).trim();
  if (r.status !== 0 || !bin.endsWith('/cli/kanon.mjs')) {
    throw new Error(`could not fetch Kanon at ${release} (exit ${r.status}): ${String(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  return dirname(dirname(bin));
}

/**
 * The release `kanon.at` names: an exact release as it is, or `previous` (`previous-1`), the
 * latest (the one before the latest) stable release of Kanon below the release under test.
 * @param {KanonContext & import('./gh.mjs').GhContext & { release: string }} ctx @param {string} which
 */
export async function resolveRelease(ctx, which) {
  if (RELEASE.test(which)) return which;
  const back = { previous: 0, 'previous-1': 1 }[which];
  if (back === undefined) throw new Error(`\`${which}\` is not previous, previous-1 or an exact release`);
  const version = (/** @type {string} */ tag) => tag.replace(/^candidate-v|^v/, '').split('.').map(Number);
  const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const under = version(ctx.release);
  const releases = await api(ctx, `repos/${KANON}/releases?per_page=100`, { paginate: true });
  const stable = releases
    .filter((/** @type {any} */ r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name) && cmp(version(r.tag_name), under) < 0)
    .map((/** @type {any} */ r) => r.tag_name)
    .sort((/** @type {string} */ a, /** @type {string} */ b) => cmp(version(b), version(a)));
  const tag = stable[back];
  if (!tag) throw new Error(`there is no stable release of Kanon below ${ctx.release} to be \`${which}\` (${stable.length} below it)`);
  return tag;
}
