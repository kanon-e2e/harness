// `pr.open` (Kanon plan 0012 §4.2): opens a pull request from a branch, into the default branch
// unless `base` says otherwise, and keeps its number under the step's `name`. A POST GitHub
// failed is asked again only when no open pull request for that head is there (#130).

import { BRANCH, NAME, bool, str } from '../lib/args.mjs';
import { api, foundAs, repoPath } from '../lib/gh.mjs';
import { remember } from '../lib/state.mjs';

export default {
  verb: 'pr.open',
  kind: 'act',
  waits: false,
  args: {
    name: str({ required: true, pattern: NAME, defines: 'prs' }),
    head: str({ required: true, pattern: BRANCH }),
    base: str({ pattern: BRANCH }),
    title: str({ required: true }),
    body: str(),
    draft: bool(),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const body = { title: step.title, head: step.head, base: step.base ?? ctx.defaultBranch, body: step.body ?? '', ...(step.draft ? { draft: true } : {}) };
    // GitHub keeps one open pull request for a head and a base: one there is the POST's (#130).
    const head = encodeURIComponent(`${ctx.repository.split('/')[0]}:${step.head}`);
    const landed = async () => foundAs((await api(ctx, repoPath(ctx, `pulls?state=open&head=${head}&base=${encodeURIComponent(body.base)}&per_page=100`)) ?? [])[0]);
    const pr = await api(ctx, repoPath(ctx, 'pulls'), { method: 'POST', body, landed });
    remember(ctx, 'prs', step.name, pr.number);
  },
};
