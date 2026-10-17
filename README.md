# harness

The harness is [Kanon](https://github.com/yedeya-labs/kanon)'s end-to-end tier. It tests Kanon from outside, the way an adopter meets it: it creates throwaway repositories in the `kanon-e2e` organisation, installs a Kanon release there, runs scenarios against it, and reports whether the release passed. Kanon's [plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) is the design. [`probes/README.md`](probes/README.md) lists the platform assumptions the plan rests on, how each was measured, and what was found.

**It is an adopter itself.** It runs Kanon's full pipeline, as any adopter does: the agent lanes, the review and the Merger, `lane-check` in CI, and Dependabot's Kanon pin bumps. It cuts its own releases through Kanon's release lane, and only because they add coverage: a repository that lives for months exercises a run of releases, pin bumps and upgrades, which a throwaway repository can't. Its end-to-end runs don't come from those releases. They run from `main`, so a fix to the harness reaches the next run at once.

**The Owner merges every change to what runs with the driver key.** The driver App's key can create and delete repositories in the test organisation and change this one. So the runner, the janitor, the `e2e*.yml` and `probe-*.yml` workflows, and every workflow that reads an environment's key are on the escalation paths as `always` ([`docs/qa/escalation-paths.md`](docs/qa/escalation-paths.md)): agents propose a change there, and the Owner decides.

## Tests

`npm ci && npm test` runs them on Vitest; CI runs them on every pull request. [`docs/qa/stack.md`](docs/qa/stack.md) lists the gates.

- `tests/escalation-paths.test.mjs` holds each pattern above on the `always` list.
- `tests/workflows.test.mjs` holds the harness's workflows to plan 0012 §5.2: no job that holds an App key runs someone else's code, each environment is named only by the jobs §5.2 lists and the probes, no `-job` workflow names a private key, and no workflow runs on a pull-request event with a secret, other than those Kanon's own lane callers map by name into their lane.
