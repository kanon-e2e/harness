// `bootstrap.end` (#59): ends bootstrap as an adopter does once the review lane runs on the
// default branch (Kanon's docs/install.md, "After merging"; `K-ADOPT-6`), with the harness's own
// code, as `repo.apply` does what init leaves to a person (decision 23 (b)). Two moves:
//
//   record:    under `## Bootstrap` in the adoption record, `ended YYYY-MM-DD` (today, UTC) in
//              place of `in bootstrap since YYYY-MM-DD` (`K-LAYOUT-10`), pushed to the default
//              branch;
//   approval:  one required approving review in the ruleset `init` would make, dismissed when a
//              new commit is pushed (`K-MERGE-6`): doctor's own fix for `ruleset.bootstrap-can-end`,
//              its rules sent as they are with the pull request rule's two settings changed.
//
// Kanon's docs name the approval first. A scenario records first: once the ruleset exists, a
// push to the default branch needs a pull request, and once it requires an approval, that pull
// request needs the Reviewer's, which a scenario with no model can't give. Doctor reads neither
// until both are done.

import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ADOPTION_RECORD, RULESET_NAME, findRuleset } from '../lib/adopt.mjs';
import { str } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';
import { IDENTITY } from './files-commit.mjs';

/** The span init writes under `## Bootstrap` (Kanon's cli/init.mjs). */
const IN_BOOTSTRAP = /`in bootstrap since \d{4}-\d{2}-\d{2}`/;

/**
 * The record with its `## Bootstrap` line ended on `day`, or null where the section, outside
 * fences, holds no `in bootstrap since` span before any other (what doctor's `bootstrapEnded` reads).
 * @param {string} text @param {string} day
 */
export const endedRecord = (text, day) => {
  const lines = text.split('\n');
  let section = '';
  let fence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^#{1,2} /.test(line)) section = line.trimEnd();
    if (section !== '## Bootstrap') continue;
    if (/`ended \d{4}-\d{2}-\d{2}`/.test(line)) return null;
    if (IN_BOOTSTRAP.test(line)) {
      lines[i] = line.replace(IN_BOOTSTRAP, `\`ended ${day}\``);
      return lines.join('\n');
    }
  }
  return null;
};

/** The first part of `path` under `clone` that is a symlink, or null. @param {string} clone @param {string} path */
const symlinked = (clone, path) => {
  let at = clone;
  for (const part of path.split('/')) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return relative(clone, at);
    } catch {
      return null;
    }
  }
  return null;
};

/** @type {Record<string, (ctx: any) => Promise<void>>} */
const MOVES = {
  record: async (ctx) => {
    if (ctx.state.bootstrapEnded) throw new Error('`bootstrap.end` `record` runs once: the adoption record already says bootstrap ended');
    const git = async (/** @type {string[]} */ args) => {
      const r = await ctx.exec('git', args, { cwd: ctx.clone });
      if (r.status !== 0) throw Object.assign(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} exited ${r.status}: ${String(r.stderr).trim()}`), { stderr: r.stderr });
      return r;
    };
    await git(['fetch', '-q', 'origin']);
    await git(['checkout', '-q', '-B', ctx.defaultBranch, `origin/${ctx.defaultBranch}`]);
    const link = symlinked(ctx.clone, ADOPTION_RECORD);
    if (link) throw new Error(`refused: \`${ADOPTION_RECORD}\` goes through \`${link}\`, a symlink`);
    const day = new Date(ctx.now()).toISOString().slice(0, 10);
    const ended = endedRecord(readFileSync(join(ctx.clone, ADOPTION_RECORD), 'utf8'), day);
    if (ended === null) throw new Error(`${ADOPTION_RECORD} has no \`in bootstrap since YYYY-MM-DD\` line under ## Bootstrap to end (K-LAYOUT-10): init wrote none, or it already says bootstrap ended`);
    writeFileSync(join(ctx.clone, ADOPTION_RECORD), ended);
    const id = ctx.identity ?? IDENTITY;
    await git(['add', '--', ADOPTION_RECORD]);
    await git(['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, 'commit', '-q', '-m', 'End bootstrap: record the date in the adoption record']);
    await git(['push', '-q', 'origin', `HEAD:refs/heads/${ctx.defaultBranch}`]);
    ctx.state.bootstrapEnded = day;
  },
  approval: async (ctx) => {
    if (!ctx.state.bootstrapEnded) throw new Error('`bootstrap.end` `approval` needs an earlier `record`: once the ruleset requires an approval, the record can\'t reach the default branch without one');
    if (ctx.state.bootstrapApproval) throw new Error('`bootstrap.end` `approval` runs once: the ruleset already requires an approving review');
    const found = await findRuleset(ctx);
    if (!found) throw new Error(`there is no ruleset named "${RULESET_NAME}" to require an approving review in`);
    const full = await api(ctx, repoPath(ctx, `rulesets/${found.id}`));
    const rules = structuredClone(full.rules ?? []);
    const pr = rules.find((/** @type {any} */ r) => r.type === 'pull_request');
    if (!pr) throw new Error(`the ruleset "${RULESET_NAME}" has no pull request rule to require an approving review in`);
    pr.parameters = { ...pr.parameters, required_approving_review_count: 1, dismiss_stale_reviews_on_push: true };
    await api(ctx, repoPath(ctx, `rulesets/${found.id}`), { method: 'PUT', body: { rules } });
    ctx.state.bootstrapApproval = true;
  },
};

export default {
  verb: 'bootstrap.end',
  kind: 'act',
  waits: false,
  args: { move: str({ required: true, enum: Object.keys(MOVES) }) },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    await MOVES[step.move](ctx);
  },
};
