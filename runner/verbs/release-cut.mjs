// `release.cut` (Kanon plan 0012 §4.2): waits for the scenario repository's release pull request,
// merges it through the front door, and waits for the Release the test Releaser publishes. One
// deadline covers the three waits. It keeps the pull request as `release` and the Release's tag.
// When the deadline passes with no Release and GitHub ran nothing on the merge commit's push, the
// step reads `infra`, not `fail` (`runner/lib/push.mjs`, #115).

import { readFileSync } from 'node:fs';

import { botLogin, api, repoPath } from '../lib/gh.mjs';
import { mergedProbe, startMerge } from '../lib/merge.mjs';
import { deadlineAt, met, poll, unmet } from '../lib/poll.mjs';
import { onPush } from '../lib/push.mjs';
import { remember } from '../lib/state.mjs';

/** The label release-please puts on the release pull request it opens. */
const PENDING = 'autorelease: pending';
const RELEASER = JSON.parse(readFileSync(new URL('../test-apps.json', import.meta.url), 'utf8')).apps.releaser;

export default {
  verb: 'release.cut',
  kind: 'act',
  waits: true,
  args: {},
  defines: () => [['prs', 'release']],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const end = deadlineAt(ctx, step.deadline);
    const pr = await poll(ctx, step.deadline, async () => {
      const open = await api(ctx, repoPath(ctx, 'pulls?state=open&per_page=100'), { paginate: true });
      const found = open.find((/** @type {any} */ p) => (p.labels ?? []).some((/** @type {any} */ l) => l.name === PENDING));
      return found ? met(found) : unmet(`no open pull request is labelled "${PENDING}" yet`);
    }, end);
    remember(ctx, 'prs', 'release', pr.number);
    const started = await startMerge(ctx, pr.number, 'front-door');
    const merged = await poll(ctx, step.deadline, mergedProbe(ctx, pr.number, started), end);
    // release-please runs on the merge commit's push: with no push run for it, `infra` (#115).
    const release = await onPush(ctx, merged.merge_commit_sha, () => poll(ctx, step.deadline, async () => {
      const releases = await api(ctx, repoPath(ctx, 'releases?per_page=20'));
      // `published_at`, not `created_at`: GitHub dates a Release's creation by its tagged commit,
      // which a merge queue builds before the pull request's `merged_at`.
      const found = releases.find((/** @type {any} */ r) => !r.draft && r.author?.login === botLogin(RELEASER) && Date.parse(r.published_at) >= Date.parse(merged.merged_at));
      return found ? met(found) : unmet(`${RELEASER} has published no Release since #${pr.number} merged`);
    }, end));
    ctx.state.release = { id: release.id, tag: release.tag_name };
  },
};
