// `expect.pr` (Kanon plan 0012 §4.2): holds a pull request an earlier step opened, or the release
// pull request `release.cut` merged, to its state (`merged` included), labels, author's App slug,
// and a known marker in a post or a review. It polls until it holds or its deadline passes.

import { NAME, str } from '../lib/args.mjs';
import { poll } from '../lib/poll.mjs';
import { named } from '../lib/state.mjs';
import { threadArgs, threadProbe, threadProblems } from '../lib/thread.mjs';

export default {
  verb: 'expect.pr',
  kind: 'read',
  waits: true,
  args: { pr: str({ required: true, pattern: NAME, ref: 'prs' }), ...threadArgs(['open', 'closed', 'merged']) },
  check: threadProblems,
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    await poll(ctx, step.deadline, threadProbe(ctx, step, named(ctx, 'prs', step.pr), true));
  },
};
