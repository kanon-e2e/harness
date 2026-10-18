// What `repo.apply` sets, held in the harness (Kanon plan 0012 decision 23 (b)): only the labels
// are in a release's requirements.json; squash-only merging, the bucket milestones and the
// ruleset come from Kanon's documented steps, `K-ADOPT-1` steps 5, 7 and 8, copied here as
// `kanon init` sets them (Kanon's cli/init.mjs, cli/milestones.mjs). A copy that drifts from
// Kanon's surfaces as doctor's `ruleset.missing` or `ruleset.rule-missing`, or a missing label;
// doctor checks neither the milestones nor the merge settings (plan 0012 §11).

/**
 * `K-ADOPT-1` step 5 (`K-SHIP-3`): squash merge only, the pull request's title and body as the
 * commit's, for `merge.settings`. `provision` sets them before this, from the release's own guard
 * (e2e.yml); tests/merge-settings.test.mjs holds this copy to Kanon's guard where it has one.
 */
export const MERGE_SETTINGS = Object.freeze({
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: 'PR_TITLE',
  squash_merge_commit_message: 'PR_BODY',
});

/** `K-ADOPT-1` step 7 (`K-WORK-4`): the two bucket milestones, with no due date. */
export const BUCKETS = Object.freeze(['Product Backlog', 'Development Automation']);

/** The ruleset's name, as `kanon init` names it, so doctor finds it. */
export const RULESET_NAME = 'Kanon: default branch';

/** The status check `lane-check`'s job reports. */
export const LANE_CHECK = 'Lane check';

/** The rule that requires `Lane check`, which `init` leaves as `ruleset.require-check` until a job reports it. */
export const CHECK_RULE = Object.freeze({
  type: 'required_status_checks',
  parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: LANE_CHECK }] },
});

/**
 * `K-ADOPT-1` step 8: the default branch's ruleset, without the required check (added by the
 * second `repo.apply`): a pull request with no required approval yet (bootstrap, `K-ADOPT-6`),
 * squash only, no force-push or deletion, and the merge queue where the plan has one.
 * @param {boolean} mergeQueue
 */
export const rulesetBody = (mergeQueue) => ({
  name: RULESET_NAME,
  target: 'branch',
  enforcement: 'active',
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        allowed_merge_methods: ['squash'],
      },
    },
    ...(mergeQueue
      ? [{
          type: 'merge_queue',
          parameters: {
            merge_method: 'SQUASH',
            grouping_strategy: 'ALLGREEN',
            min_entries_to_merge: 1,
            max_entries_to_build: 5,
            max_entries_to_merge: 5,
            min_entries_to_merge_wait_minutes: 5,
            check_response_timeout_minutes: 60,
          },
        }]
      : []),
  ],
});

/** A label of requirements.json that names a family (`signal:<name>`, `project:<n>`), not one label. @param {string} name */
export const isLabelTemplate = (name) => /<[^>]*>/.test(name);
