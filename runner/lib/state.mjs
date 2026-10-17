// The run's state, as the verbs keep it (it crosses from job to job as JSON, E4): the documents
// `kanon init` and `kanon doctor` printed, and the pull requests, issues and runs earlier steps
// made or found, each under the name the scenario gave it.

import { api, repoPath } from './gh.mjs';

const WHAT = { prs: 'pull request', issues: 'issue', runs: 'run' };

/**
 * What an earlier step kept under `name`.
 * @param {{ state: any }} ctx @param {'prs' | 'issues' | 'runs'} kind @param {string} name
 */
export const named = (ctx, kind, name) => {
  const v = ctx.state[kind]?.[name];
  if (v === undefined) throw new Error(`no earlier step made a ${WHAT[kind]} named \`${name}\``);
  return v;
};

/** Keeps `value` under `name`. @param {{ state: any }} ctx @param {'prs' | 'issues' | 'runs'} kind @param {string} name @param {any} value */
export const remember = (ctx, kind, name, value) => {
  ctx.state[kind] = { ...ctx.state[kind], [name]: value };
};

/**
 * A kept document, `{ release, exit, document }`.
 * @param {{ state: any }} ctx @param {'init' | 'doctor'} slot
 */
export const kept = (ctx, slot) => {
  const k = ctx.state.documents?.[slot];
  if (!k) throw new Error(`there is no kept \`kanon ${slot}\` document: no earlier \`kanon.${slot}\` or \`kanon.at\` ran it`);
  return k;
};

/**
 * The commit a step names: a branch's head, or a pull request's.
 * @param {import('./gh.mjs').GhContext & { state: any }} ctx @param {{ branch?: string, pr?: string }} step
 */
export async function commitOf(ctx, step) {
  if (step.pr) return (await api(ctx, repoPath(ctx, `pulls/${named(ctx, 'prs', step.pr)}`))).head.sha;
  return (await api(ctx, repoPath(ctx, `branches/${step.branch}`))).commit.sha;
}

/** The problem with a value read, or null: `what: expected X, read Y`. @param {string} what @param {unknown} expected @param {unknown} read */
export const differs = (what, expected, read) => {
  const show = (/** @type {unknown} */ v) => (typeof v === 'string' ? `\`${v}\`` : JSON.stringify(v));
  return JSON.stringify(expected) === JSON.stringify(read) ? null : `${what}: expected ${show(expected)}, read ${show(read)}`;
};
