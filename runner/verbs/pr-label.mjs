// `pr.label` (Kanon plan 0012 §4.2): adds labels to a pull request, or removes them.

import { NAME, str, strs } from '../lib/args.mjs';
import { api, foundAs, labelsOn, repoPath } from '../lib/gh.mjs';
import { named } from '../lib/state.mjs';

export default {
  verb: 'pr.label',
  kind: 'act',
  waits: false,
  args: {
    pr: str({ required: true, pattern: NAME, ref: 'prs' }),
    add: strs({ nonEmpty: true }),
    remove: strs({ nonEmpty: true }),
  },
  check: (/** @type {any} */ step) => (step.add === undefined && step.remove === undefined ? ['it changes nothing: give `add` or `remove`'] : []),
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const n = named(ctx, 'prs', step.pr);
    // Each write GitHub failed is asked again only when the pull request's labels don't show it (#130).
    if (step.add) {
      const landed = async () => { const on = await labelsOn(ctx, n); return foundAs(step.add.every((/** @type {string} */ l) => on.includes(l)) && on); };
      await api(ctx, repoPath(ctx, `issues/${n}/labels`), { method: 'POST', body: { labels: step.add }, landed });
    }
    for (const label of step.remove ?? []) {
      const landed = async () => { const on = await labelsOn(ctx, n); return on.includes(label) ? null : { answer: on }; };
      await api(ctx, repoPath(ctx, `issues/${n}/labels/${encodeURIComponent(label)}`), { method: 'DELETE', landed });
    }
  },
};
