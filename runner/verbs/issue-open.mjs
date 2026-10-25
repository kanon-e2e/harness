// `issue.open` (Kanon plan 0012 §4.2): opens an issue, with its labels, and keeps its number
// under the step's `name`. A POST GitHub failed is asked again only when the issue isn't there
// (#130).

import { NAME, str, strs } from '../lib/args.mjs';
import { api, foundAs, repoPath } from '../lib/gh.mjs';
import { remember } from '../lib/state.mjs';

export default {
  verb: 'issue.open',
  kind: 'act',
  waits: false,
  args: {
    name: str({ required: true, pattern: NAME, defines: 'issues' }),
    title: str({ required: true }),
    body: str(),
    labels: strs(),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const body = { title: step.title, body: step.body ?? '', labels: step.labels ?? [] };
    // The issue the POST made, should GitHub fail it after committing it (#130): open, of the same
    // title and body, and kept by no earlier step. The body is the step's marker, since the
    // harness adds none of its own to what Kanon reads (the no-leak rule).
    const landed = async () => {
      const kept = new Set(Object.values(ctx.state.issues ?? {}));
      const open = await api(ctx, repoPath(ctx, 'issues?state=open&sort=created&direction=desc&per_page=100')) ?? [];
      return foundAs(open.find((/** @type {any} */ i) => !i.pull_request && i.title === body.title && (i.body ?? '') === body.body && !kept.has(i.number)));
    };
    const issue = await api(ctx, repoPath(ctx, 'issues'), { method: 'POST', body, landed });
    remember(ctx, 'issues', step.name, issue.number);
  },
};
