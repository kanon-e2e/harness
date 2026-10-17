// `issue.open` (Kanon plan 0012 §4.2): opens an issue, with its labels, and keeps its number
// under the step's `name`.

import { NAME, str, strs } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';
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
    const issue = await api(ctx, repoPath(ctx, 'issues'), { method: 'POST', body: { title: step.title, body: step.body ?? '', labels: step.labels ?? [] } });
    remember(ctx, 'issues', step.name, issue.number);
  },
};
