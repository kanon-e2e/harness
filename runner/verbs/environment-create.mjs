// `environment.create` (Kanon plan 0012 step E5): creates a deployment environment in the scenario
// repository as plan 0010 §4 and §12 ask an adopter to: "Selected branches and tags" with one tag
// rule, the release tags' pattern (`tags`), and no branch rule; administrators can't bypass it.
// With `reviewer`, the Owner (runner/settings.json's `environmentReviewer`, decision 9) is its
// required reviewer, with self-review prevented. `kanon init` creates no environment, so a
// scenario of the deploy lane needs this before its first release.

import { readFileSync } from 'node:fs';
import { bool, str } from '../lib/args.mjs';
import { api, foundAs, repoPath } from '../lib/gh.mjs';

const REVIEWER = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')).environmentReviewer;

export default {
  verb: 'environment.create',
  kind: 'act',
  waits: false,
  args: {
    name: str({ required: true, pattern: /^[A-Za-z0-9._-]+$/ }),
    tags: str({ required: true, pattern: /^[A-Za-z0-9._*/-]+$/, hint: 'a tag pattern, such as v*.*.*' }),
    reviewer: bool(),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const review = step.reviewer
      ? { prevent_self_review: true, reviewers: [{ type: 'User', id: (await api(ctx, `users/${REVIEWER}`)).id }] }
      : {};
    await api(ctx, repoPath(ctx, `environments/${step.name}`), {
      method: 'PUT',
      body: { wait_timer: 0, ...review, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, can_admins_bypass: false },
    });
    const policies = repoPath(ctx, `environments/${step.name}/deployment-branch-policies`);
    const find = async () => ((await api(ctx, `${policies}?per_page=100`)).branch_policies ?? []).find((/** @type {any} */ p) => p.type === 'tag' && p.name === step.tags);
    // A POST GitHub failed is asked again only when the tag rule isn't there (#130).
    if (!(await find())) await api(ctx, policies, { method: 'POST', body: { name: step.tags, type: 'tag' }, landed: async () => foundAs(await find()) });
  },
};
