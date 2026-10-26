// Merging a pull request (Kanon plan 0012 §4.2): through the front door, squash with auto-merge
// (or into the merge queue), or as the driver where the ruleset lets a bypass actor through.
// Where the repository doesn't allow auto-merge, the front door squashes at once, as Kanon's merger
// does: `kanon init` leaves auto-merge off (`K-ADOPT-1` step 5 sets squash-only merging alone).
// Where a merge queue sets the base's strategy, GitHub refuses both, and the front door adds the
// pull request to the queue with `enqueuePullRequest`, as Kanon's Merger does (#73).
// A merge made at once doesn't wait for a required check the ruleset names, so GitHub refuses it
// until the check reports: the front door asks again within the step's deadline while a required
// check hasn't concluded, and fails at once on one that failed (#33).
// The verb that merges then polls `mergedProbe` until GitHub says it merged.

import { Fail } from './fail.mjs';
import { GhError, api, foundAs, repoPath } from './gh.mjs';
import { met, poll, unmet } from './poll.mjs';

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

// What GitHub says when a ruleset holds back a merge made at once: `gh`'s own words for a pull
// request GitHub reads as BLOCKED, and the API's for a required check that hasn't passed. Any other
// refusal (a conflict, a head behind its base) fails at once, with GitHub's answer.
const HELD = /base branch policy prohibits the merge|required status checks? .*(?:is|are) (?:expected|in progress|pending)|repository rule violations/i;
// The conclusions GitHub counts as a required check passing; a commit status's `success` too.
const PASSED = new Set(['success', 'neutral', 'skipped']);
const PENDING = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested']);

/**
 * Why a held-back merge of pull request `number` may still land: a required check that hasn't
 * concluded on its head, or every one passed and GitHub hasn't caught up. Null when it merged
 * meanwhile. Throws `Fail` when it closed, or a required check failed, and `refused` when the
 * base's rules require no check, as nothing then can lift the refusal.
 * @param {import('./gh.mjs').GhContext} ctx @param {number} number @param {GhError} refused
 * @returns {Promise<string | null>}
 */
async function heldBy(ctx, number, refused) {
  const pr = await api(ctx, repoPath(ctx, `pulls/${number}`));
  if (pr.merged) return null;
  if (pr.state === 'closed') throw new Fail(`pull request #${number} closed without merging`);
  const rules = await api(ctx, repoPath(ctx, `rules/branches/${encodeURIComponent(pr.base.ref)}?per_page=100`), { paginate: true });
  const required = (rules ?? []).filter((/** @type {any} */ r) => r.type === 'required_status_checks')
    .flatMap((/** @type {any} */ r) => r.parameters?.required_status_checks ?? []).map((/** @type {any} */ c) => String(c.context));
  if (!required.length) throw refused;
  const sha = pr.head.sha;
  /** @type {any[] | undefined} */
  let statuses;
  const waiting = [];
  for (const name of [...new Set(required)]) {
    const { check_runs: runs } = await api(ctx, repoPath(ctx, `commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`));
    let read;
    if (runs.length) {
      const latest = runs.reduce((/** @type {any} */ a, /** @type {any} */ r) => (r.id > a.id ? r : a));
      read = latest.status === 'completed' ? latest.conclusion : latest.status;
    } else {
      statuses ??= (await api(ctx, repoPath(ctx, `commits/${sha}/status`))).statuses;
      read = statuses?.find((/** @type {any} */ s) => s.context === name)?.state ?? null;
    }
    if (read === null) waiting.push(`required check \`${name}\` hasn't reported on ${sha} yet`);
    else if (PENDING.has(read)) waiting.push(`required check \`${name}\` is ${read} on ${sha}`);
    else if (!PASSED.has(read)) throw new Fail(`required check \`${name}\` concluded ${read} on ${sha}, so GitHub won't merge pull request #${number}`);
  }
  const why = String(refused.stderr).trim().split('\n')[0];
  return waiting.length ? `${waiting.join('; ')} (${why})` : `every required check passed on ${sha}, but GitHub still holds the merge back (${why})`;
}

/** @typedef {{ queue: { removedAt: string | null } | null }} Started */

/**
 * Asks GitHub to merge pull request `number`. Returns what `mergedProbe` follows: on a queue,
 * when the queue last removed the pull request before this merge asked, so a later removal is
 * this one's. A merge made at once that a required check holds back is asked again until
 * `deadline` (#33): its minutes, and the step's end when one deadline covers more than one wait.
 * @param {import('./gh.mjs').GhContext & { now: () => number, sleep: (ms: number) => Promise<void> }} ctx
 * @param {number} number @param {'front-door' | 'bypass'} via
 * @param {{ minutes: number, end?: number }} deadline
 * @returns {Promise<Started>}
 */
export async function startMerge(ctx, number, via, deadline) {
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
  // doesn't allow it: merge it now. GitHub refuses that merge while a required check hasn't passed,
  // so it is asked again within the deadline (#33).
  if (auto && r.status !== 0 && /clean status|auto merge is not allowed/i.test(r.stderr)) {
    await poll(ctx, deadline.minutes, async () => {
      const tried = await ctx.gh(base, undefined, landedIf(false));
      if (tried.status === 0) return met();
      const refused = new GhError(`pr merge ${number}`, tried);
      if (!HELD.test(tried.stderr)) throw refused;
      const why = await heldBy(ctx, number, refused);
      return why === null ? met() : unmet(why);
    }, deadline.end);
    return { queue: null };
  }
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
