// A push GitHub never delivered (harness #115, the Owner's decision of 2026-10-22), told from a
// push nothing was set to run on (#126, the Owner's decision of 2026-10-25). A step that waits on
// what a push to the scenario repository starts (`release.cut`, `run.await` on `push`) fails when
// its deadline passes. Then:
//
//   - With a workflow and a branch (`run.await`), it reads the pushed commit's tree first. When
//     that workflow isn't in it, or its `on:` runs it on no push to that branch (event and branch
//     filters included), nothing was ever going to run: the deadline stays `fail`, a Kanon
//     finding (a `ci.yml` that `kanon init` didn't write, or wrote without its push trigger).
//     Only when the tree says it should have run does it go on to ask about the push.
//   - It asks GitHub once whether any workflow run of any kind exists for that commit's push.
//     None means the push event never reached a workflow, which is GitHub's failure, not
//     Kanon's: the step reads `infra`, naming the commit.
//
// With a push run there, an answer it can't read, or a trigger it can't judge (a `paths` filter,
// a flow-style `on:`), the deadline stays `fail`: `infra` needs proof, and `infra` never reads as
// a pass. `release.cut` names no workflow, and its `release.yml` comes from the harness's own
// `start/`, so it skips the tree read.
//
// The runner installs no dependencies, so `pushRuns` reads `on:` itself: the block and flow-list
// forms workflows are written in, not YAML at large.

import { Fail } from './fail.mjs';
import { api, notFound, repoPath } from './gh.mjs';
import { infra } from './retry.mjs';

/** A scalar, its quotes dropped. @param {string} v */
const scalar = (v) => {
  const t = v.trim();
  const q = /^(["'])(.*)\1$/.exec(t);
  return q ? q[2] : t;
};

/** A line with its comment dropped: a `#` at the start or after a space, outside quotes. @param {string} line */
const uncomment = (line) => {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
};

const indent = (/** @type {string} */ l) => l.length - l.trimStart().length;
const isItem = (/** @type {string} */ l) => /^\s*-(\s|$)/.test(l);
const empty = (/** @type {string} */ v) => !v || v === '~' || v === 'null';

/**
 * The value of a key, from its inline text and the lines under it: a flow list, a block list or
 * a scalar. `undefined` for none, `null` for what it can't read.
 * @param {string} inline @param {string[]} lines @returns {string[] | string | null | undefined}
 */
const valueOf = (inline, lines) => {
  const v = inline.trim();
  if (v.startsWith('[')) return v.endsWith(']') ? v.slice(1, -1).split(',').map(scalar).filter(Boolean) : null;
  if (v.startsWith('{')) return v === '{}' ? undefined : null;
  if (!empty(v)) return scalar(v);
  if (!lines.length) return undefined;
  if (lines.every(isItem)) return lines.map((l) => scalar(l.trimStart().slice(1)));
  return null;
};

/**
 * A block's keys, each with its inline value and the lines under it (a block list may sit at the
 * key's own indent), or null for a block that isn't a mapping.
 * @param {string[]} lines @returns {Map<string, { inline: string, lines: string[] }> | null}
 */
const mapping = (lines) => {
  const keys = new Map();
  if (!lines.length) return keys;
  const at = Math.min(...lines.map(indent));
  /** @type {{ inline: string, lines: string[] } | null} */
  let current = null;
  for (const l of lines) {
    if (indent(l) === at && !isItem(l)) {
      const m = /^\s*("[^"]*"|'[^']*'|[^:\s][^:]*?)\s*:(?:\s(.*)|)$/.exec(l);
      if (!m) return null;
      current = { inline: m[2] ?? '', lines: [] };
      keys.set(scalar(m[1]), current);
    } else if (current) current.lines.push(l);
    else return null;
  }
  return keys;
};

/** A filter's pattern as a regular expression: `*`, `**`, `?`, `+` and `[…]` as GitHub reads them. @param {string} p */
const glob = (p) => {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') { if (p[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?' || c === '+') re += c;
    else if (c === '[' && p.indexOf(']', i) > i) { const end = p.indexOf(']', i); re += p.slice(i, end + 1); i = end; }
    else re += c.replace(/[.\\^$|(){}[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};

/** Whether `branch` passes `branches`: the last pattern it matches decides, a `!` one excluding. @param {string[]} patterns @param {string} branch */
const included = (patterns, branch) => {
  let yes = false;
  for (const p of patterns) {
    if (p.startsWith('!')) { if (glob(p.slice(1)).test(branch)) yes = false; } else if (glob(p).test(branch)) yes = true;
  }
  return yes;
};

const ON = /^("on"|'on'|on|true)\s*:/;

/**
 * Whether a workflow whose text is `text` runs on a push to `branch`: `yes`, `no`, or `unknown`
 * when it can't tell (a `paths` filter, which turns on what the push changed, or an `on:` it
 * can't read).
 * @param {string} text @param {string} branch @returns {'yes' | 'no' | 'unknown'}
 */
export function pushRuns(text, branch) {
  const lines = String(text).split(/\r?\n/).map(uncomment).filter((l) => l.trim());
  const start = lines.findIndex((l) => ON.test(l));
  if (start < 0) return 'no';
  const under = [];
  for (let i = start + 1; i < lines.length && (indent(lines[i]) > 0 || isItem(lines[i])); i++) under.push(lines[i]);
  const inline = lines[start].replace(ON, '');
  const events = valueOf(inline, under);
  if (typeof events === 'string') return events === 'push' ? 'yes' : 'no';
  if (Array.isArray(events)) return events.includes('push') ? 'yes' : 'no';
  if (inline.trim()) return 'unknown';
  const keys = mapping(under);
  if (!keys) return 'unknown';
  const push = keys.get('push');
  if (!push) return 'no';
  const v = push.inline.trim();
  if (v === '{}' || (empty(v) && !push.lines.length)) return 'yes';
  if (!empty(v)) return 'unknown';
  const filters = mapping(push.lines);
  if (!filters) return 'unknown';
  /** @type {Record<string, string[]>} */
  const f = {};
  for (const [k, { inline: i, lines: l }] of filters) {
    const read = valueOf(i, l);
    if (read === null) return 'unknown';
    f[k] = read === undefined ? [] : Array.isArray(read) ? read : [read];
  }
  if (f.branches) { if (!included(f.branches, branch)) return 'no'; }
  else if (f['branches-ignore']) { if (f['branches-ignore'].some((p) => glob(p).test(branch))) return 'no'; }
  // Only tags filtered: GitHub runs it on no branch's push.
  else if (f.tags || f['tags-ignore']) return 'no';
  return f.paths || f['paths-ignore'] ? 'unknown' : 'yes';
}

/**
 * Runs `wait`, the wait on what commit `sha`'s push starts. A `Fail` it throws, its deadline
 * passing, is thrown as `infra` when GitHub records no workflow run of any kind for that push and,
 * given `on`, the commit's tree runs `on.workflow` on a push to `on.branch()`. Given `on`, a tree
 * that doesn't run it keeps the `Fail`, saying why.
 * @template T
 * @param {import('./gh.mjs').GhContext} ctx @param {string | undefined} sha @param {() => Promise<T>} wait
 * @param {{ workflow: string, branch: () => Promise<string> }} [on]
 * @returns {Promise<T>}
 */
export async function onPush(ctx, sha, wait, on) {
  try {
    return await wait();
  } catch (e) {
    if (!(e instanceof Fail) || !sha) throw e;
    if (on) {
      const path = `.github/workflows/${on.workflow}`;
      let read;
      let branch;
      try {
        branch = await on.branch();
        const file = await api(ctx, repoPath(ctx, `contents/${path}?ref=${sha}`));
        read = pushRuns(Buffer.from(String(file?.content ?? ''), 'base64').toString('utf8'), branch);
      } catch (x) {
        if (notFound(x)) throw new Fail(`${e.message}; ${sha}'s tree has no ${path}, so nothing was set to run on its push`);
        throw e;
      }
      if (read === 'no') throw new Fail(`${e.message}; ${on.workflow} in ${sha}'s tree runs on no push to ${branch}`);
      if (read === 'unknown') throw e;
    }
    let runs;
    try {
      runs = await api(ctx, repoPath(ctx, `actions/runs?event=push&head_sha=${sha}&per_page=1`));
    } catch {
      throw e;
    }
    if (runs?.total_count === 0) throw infra(`${e.message}; no push run was delivered for ${sha}: GitHub records no workflow run of any kind for its push`);
    throw e;
  }
}
