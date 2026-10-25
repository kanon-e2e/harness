// The verbs' one way to GitHub: `gh`, as the runner hands it over in the context (E4), so each
// verb's test stubs it. `ctx.gh(args, input)` resolves to `{ status, stdout, stderr }`.

import { infra, isWrite } from './retry.mjs';

/** @typedef {{ status: number, stdout: string, stderr: string }} Result */
/** @typedef {{ gh: (args: string[], input?: string, opts?: { landed?: () => Promise<{ answer: any } | null> }) => Promise<Result>, repository: string }} GhContext */

/** A `gh` call that exited non-zero. The runner classifies it (E4); a verb doesn't. */
export class GhError extends Error {
  /** @param {string} what @param {Result} r */
  constructor(what, r) {
    super(`gh ${what} exited ${r.status}: ${String(r.stderr).trim() || 'no output'}`);
    this.name = 'GhError';
    this.status = r.status;
    this.stderr = r.stderr;
  }
}

/** Whether `e` is a `gh` call GitHub answered 404, as `gh` writes it: `Not Found (HTTP 404)`. @param {unknown} e */
export const notFound = (e) => e instanceof GhError && /\bHTTP 404\b/.test(String(e.stderr));

/** @typedef {() => Promise<{ answer: any } | null>} Landed */

/**
 * One REST call: `gh api [-X METHOD] [--paginate --slurp] <path> [--input -]`, its body sent as
 * JSON. Returns the parsed answer, or null for an empty one. Paginated pages come back as one list.
 *
 * A write's `landed` reads whether GitHub committed it (#130): the runner's retried `gh` asks it
 * before asking the write again, and an answer GitHub cut off is read from it. A write's cut-off
 * answer that no lookup finds reads `infra`; a read's stays the harness's own error.
 * @param {GhContext} ctx @param {string} path
 * @param {{ method?: string, body?: any, paginate?: boolean, landed?: Landed }} [opts]
 */
export async function api(ctx, path, { method = 'GET', body, paginate = false, landed } = {}) {
  const args = ['api'];
  if (method !== 'GET') args.push('-X', method);
  if (paginate) args.push('--paginate', '--slurp');
  args.push(path);
  if (body !== undefined) args.push('--input', '-');
  const input = body === undefined ? undefined : JSON.stringify(body);
  const r = await (landed ? ctx.gh(args, input, { landed }) : ctx.gh(args, input));
  if (r.status !== 0) throw new GhError(`api ${method} ${path}`, r);
  const text = String(r.stdout ?? '').trim();
  if (!text) return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    if (!isWrite(args, input)) throw e;
    const found = landed ? await landed() : null;
    if (found) return found.answer;
    throw infra(`gh api ${method} ${path}: GitHub's answer was cut off (${/** @type {Error} */ (e).message}), and no lookup found what it wrote`);
  }
  return paginate && Array.isArray(json) ? json.flat() : json;
}

/**
 * A lookup for a DELETE of `path`: landed when GitHub answers the path 404.
 * @param {GhContext} ctx @param {string} path @returns {Landed}
 */
export const goneFrom = (ctx, path) => async () => {
  try {
    await api(ctx, path);
    return null;
  } catch (e) {
    if (notFound(e)) return { answer: null };
    throw e;
  }
};

/** The names of the labels on issue or pull request `n`. @param {GhContext} ctx @param {number} n */
export const labelsOn = async (ctx, n) => ((await api(ctx, repoPath(ctx, `issues/${n}/labels?per_page=100`))) ?? []).map((/** @type {any} */ l) => l.name);

/** A lookup's answer: `{ answer: found }`, or null when nothing was found. @param {any} found */
export const foundAs = (found) => (found === undefined || found === null || found === false ? null : { answer: found });

/** The scenario repository's REST path for `rest`. @param {GhContext} ctx @param {string} rest */
export const repoPath = (ctx, rest = '') => `repos/${ctx.repository}${rest ? `/${rest}` : ''}`;

/** A login for an App's slug, as GitHub writes a bot's. @param {string} slug */
export const botLogin = (slug) => `${slug}[bot]`;
