// `pr.merge` (Kanon plan 0012 §4.2): merges a pull request through the front door, or as the
// driver where the ruleset lets a bypass actor through, which the scenario says; then polls until
// GitHub says it merged.

import { NAME, str } from '../lib/args.mjs';
import { mergedProbe, startMerge } from '../lib/merge.mjs';
import { poll } from '../lib/poll.mjs';
import { named } from '../lib/state.mjs';

export default {
  verb: 'pr.merge',
  kind: 'act',
  waits: true,
  args: {
    pr: str({ required: true, pattern: NAME, ref: 'prs' }),
    via: str({ required: true, enum: ['front-door', 'bypass'] }),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const n = named(ctx, 'prs', step.pr);
    await startMerge(ctx, n, step.via);
    await poll(ctx, step.deadline, mergedProbe(ctx, n));
  },
};
