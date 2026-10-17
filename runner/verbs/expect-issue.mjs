// `expect.issue` (Kanon plan 0012 §4.2): holds an issue an earlier step opened to its state,
// labels, author's App slug, and a known marker in a post. It polls until it holds or its
// deadline passes.

import { NAME, str } from '../lib/args.mjs';
import { poll } from '../lib/poll.mjs';
import { named } from '../lib/state.mjs';
import { threadArgs, threadProbe, threadProblems } from '../lib/thread.mjs';

export default {
  verb: 'expect.issue',
  kind: 'read',
  waits: true,
  args: { issue: str({ required: true, pattern: NAME, ref: 'issues' }), ...threadArgs(['open', 'closed']) },
  check: threadProblems,
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    await poll(ctx, step.deadline, threadProbe(ctx, step, named(ctx, 'issues', step.issue), false));
  },
};
