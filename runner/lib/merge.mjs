// Merging a pull request (Kanon plan 0012 §4.2): through the front door, squash with auto-merge
// (or into the merge queue), or as the driver where the ruleset lets a bypass actor through.
// Where the repository doesn't allow auto-merge, the front door squashes at once, as Kanon's merger
// does: `kanon init` leaves auto-merge off (`K-ADOPT-1` step 5 sets squash-only merging alone).
// Where a merge queue sets the base's strategy, GitHub refuses both, and the front door adds the
// pull request to the queue with `enqueuePullRequest`, as Kanon's Merger does (#73).
// The verb that merges then polls `mergedProbe` until GitHub says it merged.

import { Fail } from './fail.mjs';
import { GhError, api, foundAs, repoPath } from './gh.mjs';
import { met, unmet } from './poll.mjs';

// `isMergeQueueEnabled` is the field `gh pr merge` reads for the same question: it answers for a
// queue a ruleset sets and one branch protection sets alike. The queue's last removal of the pull
// request tells an ejection from a merge, which GitHub records as a removal too, reason `merged`.
const QUEUE_STATE = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid isMergeQueueEnabled isInMergeQueue timelineItems(itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT],last:1){nodes{... on RemovedFromMergeQueueEvent{createdAt reason}}}}}}';
// Pinned to the head just read, so the queue never takes a head pushed since.
const ENQUEUE = 'mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position}}}';

/**
 * Pull request `number`'s merge-queue state, and the queue's last removal of it, or null.
 * @param {import('./gh.mjs').GhContext} ctx @param {number} number
 */
async function queueState(ctx, number) {
  const [owner, name] = ctx.repository.split('/');
  const answer = await api(ctx, 'graphql', { method: 'POST', body: { query: QUEUE_STATE, variables: { owner, name, number } } });
  const pr = answer?.data?.repository?.pullRequest;
  if (typeof pr?.isMergeQueueEnabled !== 'boolean' || typeof pr.isInMergeQueue !== 'boolean' || !Array.isArray(pr.timelineItems?.nodes)) {
    throw new Error(`no merge-queue state for pull request #${number} in ${JSON.stringify(answer)}`);
  }
  return { ...pr, removed: pr.timelineItems.nodes.at(-1) ?? null };
}

/** @typedef {{ queue: { removedAt: string | null } | null }} Started */

/**
 * Asks GitHub to merge pull request `number`. Returns what `mergedProbe` follows: on a queue,
 * when the queue last removed the pull request before this merge asked, so a later removal is
 * this one's.
 * @param {import('./gh.mjs').GhContext} ctx @param {number} number @param {'front-door' | 'bypass'} via
 * @returns {Promise<Started>}
 */
export async function startMerge(ctx, number, via) {
  if (via !== 'bypass') {
    const q = await queueState(ctx, number);
    if (q.isMergeQueueEnabled) {
      // An enqueue GitHub failed is asked again only when the pull request isn't in the queue (#130).
      const landed = async () => foundAs((await queueState(ctx, number)).isInMergeQueue && { data: { enqueuePullRequest: null } });
      if (!q.isInMergeQueue) await api(ctx, 'graphql', { method: 'POST', body: { query: ENQUEUE, variables: { id: q.id, head: q.headRefOid } }, landed });
      return { queue: { removedAt: q.removed?.createdAt ?? null } };
    }
  }
  const base = ['pr', 'merge', String(number), '-R', ctx.repository, '--squash'];
  // A `pr merge` GitHub failed is asked again only when the pull request hasn't merged, nor, for
  // `--auto`, had auto-merge turned on (#130).
  const landedIf = (/** @type {boolean} */ auto) => ({ landed: async () => {
    const pr = await api(ctx, repoPath(ctx, `pulls/${number}`));
    return foundAs((pr.merged || (auto && pr.auto_merge)) && pr);
  } });
  const auto = via !== 'bypass';
  let r = await ctx.gh([...base, auto ? '--auto' : '--admin'], undefined, landedIf(auto));
  // Auto-merge can't be turned on for a pull request that can merge now, nor in a repository that
  // doesn't allow it: merge it now.
  if (auto && r.status !== 0 && /clean status|auto merge is not allowed/i.test(r.stderr)) r = await ctx.gh(base, undefined, landedIf(false));
  if (r.status !== 0) throw new GhError(`pr merge ${number}`, r);
  return { queue: null };
}

/**
 * Whether pull request `number` has merged. One closed unmerged fails the step at once, and so
 * does one the merge queue removed without merging it.
 * @param {import('./gh.mjs').GhContext} ctx @param {number} number @param {Started} [started] `startMerge`'s answer
 */
export const mergedProbe = (ctx, number, started = { queue: null }) => async () => {
  const pr = await api(ctx, repoPath(ctx, `pulls/${number}`));
  if (pr.merged) return met(pr);
  if (pr.state === 'closed') throw new Fail(`pull request #${number} closed without merging`);
  if (!started.queue) return unmet(`pull request #${number} is not merged yet`);
  const q = await queueState(ctx, number);
  const removed = q.removed && q.removed.createdAt !== started.queue.removedAt ? q.removed : null;
  if (!q.isInMergeQueue && removed && String(removed.reason).toLowerCase() !== 'merged') {
    throw new Fail(`the merge queue removed pull request #${number} without merging it (${removed.reason ?? 'no reason given'})`);
  }
  return unmet(`pull request #${number} is ${q.isInMergeQueue ? 'in the merge queue' : 'out of the merge queue'}, not merged yet`);
};
