// A push GitHub never delivered (harness #115, the Owner's decision of 2026-10-22). A step that
// waits on what a push to the scenario repository starts (`release.cut`, `run.await` on `push`)
// fails when its deadline passes. Then it asks GitHub once more whether any workflow run of any
// kind exists for that commit's push. None means the push event never reached a workflow, which
// is GitHub's failure, not Kanon's: the step reads `infra`, naming the commit. With one, or with
// an answer it can't read, the deadline stays `fail`: a caller that ran and did nothing is a
// finding, and `infra` never reads as a pass.

import { Fail } from './fail.mjs';
import { api, repoPath } from './gh.mjs';
import { infra } from './retry.mjs';

/**
 * Runs `wait`, the wait on what commit `sha`'s push starts. A `Fail` it throws, its deadline
 * passing, is thrown as `infra` when GitHub records no workflow run of any kind for that push.
 * @template T
 * @param {import('./gh.mjs').GhContext} ctx @param {string | undefined} sha @param {() => Promise<T>} wait
 * @returns {Promise<T>}
 */
export async function onPush(ctx, sha, wait) {
  try {
    return await wait();
  } catch (e) {
    if (!(e instanceof Fail) || !sha) throw e;
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
