// `repo.apply` (Kanon plan 0012 §4.2, decision 23 (b)): does what the kept `kanon init`
// document's `steps-left` findings leave to a person, with the harness's own code, since the
// `kanon` job's token is read-only. It applies only what those findings name:
//
//   first call:  `merge.settings` (K-ADOPT-1 step 5), `label.create` (step 6: the labels the
//                release's requirements.json lists, read as data), `milestone.buckets` (step 7),
//                `ruleset.create` (step 8);
//   second call: `ruleset.require-check`, the ruleset's required `Lane check` rule, once the
//                pushed callers are on the default branch and a job there reports it.
//
// The count starts again when a new `init` document is kept (`kanon.init`, or `kanon.at` with
// `init`), so an upgrade's `init` at the release under test gets its own two calls: the first
// creates what the new release adds, such as a new label.
//
// `init`'s read-only token can't see the merge settings, so it names no `merge.settings`; the
// `provision` job sets them, as the release under test's guard checks them, before the first
// push (e2e.yml, #36).
//
// On a default branch with no commit, `init` names neither ruleset finding but
// `ruleset.first-commit`: push the first commit, then run `init` again, which creates the ruleset
// (K-ADOPT-4). A step with `firstCommit`, which follows that push, applies what that run would
// name: `ruleset.create`, then `ruleset.require-check` (#55). Without it, `ruleset.first-commit`
// applies nothing, as before.
//
// A POST GitHub failed is asked again only when what it creates isn't there: the label, the
// milestone, the ruleset by its name (#130).

import { BUCKETS, CHECK_RULE, LANE_CHECK, MERGE_SETTINGS, RULESET_NAME, findRuleset as ruleset, isLabelTemplate, rulesetBody } from '../lib/adopt.mjs';
import { bool } from '../lib/args.mjs';
import { api, foundAs, notFound, repoPath } from '../lib/gh.mjs';
import { kept } from '../lib/state.mjs';

/** The findings each call applies, in K-ADOPT-1's order. */
const CALLS = [['merge.settings', 'label.create', 'milestone.buckets', 'ruleset.create'], ['ruleset.require-check']];
/** What `init`'s run after the first commit names in place of `ruleset.first-commit`. */
const AFTER_FIRST_COMMIT = ['ruleset.create', 'ruleset.require-check'];

/** @typedef {{ release: string, document: any }} Kept */

/** @type {Record<string, (ctx: any, k: Kept) => Promise<void>>} */
const APPLY = {
  'merge.settings': async (ctx) => {
    await api(ctx, repoPath(ctx), { method: 'PATCH', body: MERGE_SETTINGS });
  },
  'label.create': async (ctx, k) => {
    const file = await api(ctx, `repos/yedeya-labs/kanon/contents/requirements.json?ref=${k.release}`);
    const wanted = JSON.parse(Buffer.from(file.content, file.encoding).toString('utf8')).labels.filter((/** @type {string} */ l) => !isLabelTemplate(l));
    const have = new Set((await api(ctx, repoPath(ctx, 'labels?per_page=100'), { paginate: true })).map((/** @type {any} */ l) => l.name));
    for (const name of wanted) {
      if (have.has(name)) continue;
      const landed = () => api(ctx, repoPath(ctx, `labels/${encodeURIComponent(name)}`)).then(foundAs, (e) => { if (notFound(e)) return null; throw e; });
      await api(ctx, repoPath(ctx, 'labels'), { method: 'POST', body: { name }, landed });
    }
  },
  'milestone.buckets': async (ctx) => {
    const have = new Set((await api(ctx, repoPath(ctx, 'milestones?state=all&per_page=100'), { paginate: true })).map((/** @type {any} */ m) => m.title));
    for (const title of BUCKETS) {
      if (have.has(title)) continue;
      const landed = async () => foundAs((await api(ctx, repoPath(ctx, 'milestones?state=all&per_page=100'), { paginate: true })).find((/** @type {any} */ m) => m.title === title));
      await api(ctx, repoPath(ctx, 'milestones'), { method: 'POST', body: { title }, landed });
    }
  },
  'ruleset.create': async (ctx, k) => {
    if (await ruleset(ctx)) return;
    await api(ctx, repoPath(ctx, 'rulesets'), { method: 'POST', body: rulesetBody(k.document.inspection?.mergeQueue === 'yes'), landed: async () => foundAs(await ruleset(ctx)) });
  },
  'ruleset.require-check': async (ctx) => {
    const found = await ruleset(ctx);
    if (!found) throw new Error(`there is no ruleset named "${RULESET_NAME}" to add the required "${LANE_CHECK}" check to`);
    const full = await api(ctx, repoPath(ctx, `rulesets/${found.id}`));
    const rules = structuredClone(full.rules ?? []);
    const checks = rules.find((/** @type {any} */ r) => r.type === 'required_status_checks');
    const listed = (checks?.parameters?.required_status_checks ?? []).some((/** @type {any} */ c) => c.context === LANE_CHECK);
    if (listed) return;
    if (checks) checks.parameters = { ...checks.parameters, required_status_checks: [...(checks.parameters?.required_status_checks ?? []), { context: LANE_CHECK }] };
    else rules.push(structuredClone(CHECK_RULE));
    await api(ctx, repoPath(ctx, `rulesets/${found.id}`), { method: 'PUT', body: { rules } });
  },
};

export default {
  verb: 'repo.apply',
  kind: 'act',
  waits: false,
  args: { firstCommit: bool() },
  uses: () => [['documents', 'init']],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const k = kept(ctx, 'init');
    const call = ctx.state.repoApply ?? 0;
    if (call >= CALLS.length) throw new Error('repo.apply runs at most twice for each kept init document: this is a third call');
    const named = new Set((k.document.findings ?? []).map((/** @type {any} */ f) => f.id));
    if (step.firstCommit && named.has('ruleset.first-commit')) for (const id of AFTER_FIRST_COMMIT) named.add(id);
    const applying = CALLS[call].filter((id) => named.has(id));
    for (const id of applying) await APPLY[id](ctx, k);
    ctx.state.repoApply = call + 1;
    ctx.state.applied = [...(ctx.state.applied ?? []), ...applying];
  },
};
