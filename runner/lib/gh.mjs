// The verbs' one way to GitHub: `gh`, as the runner hands it over in the context (E4), so each
// verb's test stubs it. `ctx.gh(args, input)` resolves to `{ status, stdout, stderr }`.

/** @typedef {{ status: number, stdout: string, stderr: string }} Result */
/** @typedef {{ gh: (args: string[], input?: string) => Promise<Result>, repository: string }} GhContext */

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

/**
 * One REST call: `gh api [-X METHOD] [--paginate --slurp] <path> [--input -]`, its body sent as
 * JSON. Returns the parsed answer, or null for an empty one. Paginated pages come back as one list.
 * @param {GhContext} ctx @param {string} path
 * @param {{ method?: string, body?: any, paginate?: boolean }} [opts]
 */
export async function api(ctx, path, { method = 'GET', body, paginate = false } = {}) {
  const args = ['api'];
  if (method !== 'GET') args.push('-X', method);
  if (paginate) args.push('--paginate', '--slurp');
  args.push(path);
  if (body !== undefined) args.push('--input', '-');
  const r = await ctx.gh(args, body === undefined ? undefined : JSON.stringify(body));
  if (r.status !== 0) throw new GhError(`api ${method} ${path}`, r);
  const text = String(r.stdout ?? '').trim();
  if (!text) return null;
  const json = JSON.parse(text);
  return paginate && Array.isArray(json) ? json.flat() : json;
}

/** The scenario repository's REST path for `rest`. @param {GhContext} ctx @param {string} rest */
export const repoPath = (ctx, rest = '') => `repos/${ctx.repository}${rest ? `/${rest}` : ''}`;

/** A login for an App's slug, as GitHub writes a bot's. @param {string} slug */
export const botLogin = (slug) => `${slug}[bot]`;
