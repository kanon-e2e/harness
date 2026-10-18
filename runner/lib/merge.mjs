// Merging a pull request (Kanon plan 0012 §4.2): through the front door, squash with auto-merge
// (or into the merge queue), or as the driver where the ruleset lets a bypass actor through.
// Where the repository doesn't allow auto-merge, the front door squashes at once, as Kanon's merger
// does: `kanon init` leaves auto-merge off (`K-ADOPT-1` step 5 sets squash-only merging alone).
// The verb that merges then polls `mergedProbe` until GitHub says it merged.

import { Fail } from './fail.mjs';
import { GhError, api, repoPath } from './gh.mjs';
import { met, unmet } from './poll.mjs';

/**
 * Asks GitHub to merge pull request `number`.
 * @param {import('./gh.mjs').GhContext} ctx @param {number} number @param {'front-door' | 'bypass'} via
 */
export async function startMerge(ctx, number, via) {
  const base = ['pr', 'merge', String(number), '-R', ctx.repository, '--squash'];
  let r = await ctx.gh([...base, via === 'bypass' ? '--admin' : '--auto']);
  // Auto-merge can't be turned on for a pull request that can merge now, nor in a repository that
  // doesn't allow it: merge it now.
  if (via !== 'bypass' && r.status !== 0 && /clean status|auto merge is not allowed/i.test(r.stderr)) r = await ctx.gh(base);
  if (r.status !== 0) throw new GhError(`pr merge ${number}`, r);
}

/**
 * Whether pull request `number` has merged. One closed unmerged fails the step at once.
 * @param {import('./gh.mjs').GhContext} ctx @param {number} number
 */
export const mergedProbe = (ctx, number) => async () => {
  const pr = await api(ctx, repoPath(ctx, `pulls/${number}`));
  if (pr.merged) return met(pr);
  if (pr.state === 'closed') throw new Fail(`pull request #${number} closed without merging`);
  return unmet(`pull request #${number} is not merged yet`);
};
