// `pr.open` (Kanon plan 0012 §4.2): opens a pull request from a branch, into the default branch
// unless `base` says otherwise, and keeps its number under the step's `name`.

import { BRANCH, NAME, bool, str } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';
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
    const pr = await api(ctx, repoPath(ctx, 'pulls'), { method: 'POST', body });
    remember(ctx, 'prs', step.name, pr.number);
  },
};
