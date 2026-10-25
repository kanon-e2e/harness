// `ruleset.tags` (Kanon plan 0012 step E5): creates the scenario repository's release-tag ruleset,
// as plan 0010 §12 asks and doctor's `deploy.tag-ruleset` reads it: active, on the tags of a
// `pattern`, with the creation, update and deletion rules, and the test Apps in `bypass` (as
// scenario.json's `apps` names them) let through, the Releaser that tags each release among them.
// It creates nothing when the repository already has it.

import { readFileSync } from 'node:fs';
import { str, strs } from '../lib/args.mjs';
import { api, foundAs, repoPath } from '../lib/gh.mjs';

const APPS = JSON.parse(readFileSync(new URL('../test-apps.json', import.meta.url), 'utf8')).apps;

/** The ruleset's name. */
export const TAG_RULESET = 'Release tags';

export default {
  verb: 'ruleset.tags',
  kind: 'act',
  waits: false,
  args: {
    pattern: str({ required: true, pattern: /^[A-Za-z0-9._*-]+$/, hint: 'a tag pattern, such as v*.*.*' }),
    bypass: strs({ items: { enum: Object.keys(APPS) } }),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const find = async () => (await api(ctx, repoPath(ctx, 'rulesets?per_page=100'), { paginate: true })).find((/** @type {any} */ r) => r.name === TAG_RULESET);
    if (await find()) return;
    const bypass = [];
    for (const app of step.bypass ?? []) bypass.push({ actor_id: (await api(ctx, `apps/${APPS[app]}`)).id, actor_type: 'Integration', bypass_mode: 'always' });
    await api(ctx, repoPath(ctx, 'rulesets'), {
      method: 'POST',
      body: {
        name: TAG_RULESET,
        target: 'tag',
        enforcement: 'active',
        conditions: { ref_name: { include: [`refs/tags/${step.pattern}`], exclude: [] } },
        rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
        bypass_actors: bypass,
      },
      // A POST GitHub failed is asked again only when no ruleset of the name is there (#130).
      landed: async () => foundAs(await find()),
    });
  },
};
