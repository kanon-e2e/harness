// `issue.label` (Kanon plan 0012 §4.2): adds labels to an issue.

import { NAME, str, strs } from '../lib/args.mjs';
import { api, foundAs, labelsOn, repoPath } from '../lib/gh.mjs';
import { named } from '../lib/state.mjs';

export default {
  verb: 'issue.label',
  kind: 'act',
  waits: false,
  args: {
    issue: str({ required: true, pattern: NAME, ref: 'issues' }),
    add: strs({ required: true, nonEmpty: true }),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const n = named(ctx, 'issues', step.issue);
    const landed = async () => { const on = await labelsOn(ctx, n); return foundAs(step.add.every((/** @type {string} */ l) => on.includes(l)) && on); };
    await api(ctx, repoPath(ctx, `issues/${n}/labels`), { method: 'POST', body: { labels: step.add }, landed });
  },
};
