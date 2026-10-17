# harness

The harness is [Kanon](https://github.com/yedeya-labs/kanon)'s end-to-end tier. It tests Kanon from outside, the way an adopter meets it: it creates throwaway repositories in the `kanon-e2e` organisation, installs a Kanon release there, runs scenarios against it, and reports whether the release passed. Kanon's [plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) is the design. [`probes/README.md`](probes/README.md) lists the platform assumptions the plan rests on, how each was measured, and what was found.

**It is an adopter itself.** It runs Kanon's full pipeline, as any adopter does: the agent lanes, the review and the Merger, `lane-check` in CI, and Dependabot's Kanon pin bumps. It cuts its own releases through Kanon's release lane, and only because they add coverage: a repository that lives for months exercises a run of releases, pin bumps and upgrades, which a throwaway repository can't. Its end-to-end runs don't come from those releases. They run from `main`, so a fix to the harness reaches the next run at once.

**It sends its telemetry and its upstream findings to Kanon, as an adopter that opts in.** Its collector's caller, `.github/workflows/telemetry.yml`, sends its lanes' run data to Kanon's hosted store ([Kanon's sharing docs](https://github.com/yedeya-labs/kanon/blob/main/docs/sharing.md)), and its adoption record says ``- **Upstream findings:** `sent with evidence` ``, so what its Overseer finds about Kanon itself is sent with its evidence, after the scrub. Its rows are a long-lived adopter's real run data, and its install tests the hosted path from a fresh repository. **Its scenario repositories send neither** ([plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) §4.2, decision 8): the install there declines telemetry and sharing, and installs no collector. `tests/telemetry.test.mjs` holds both.

**The Owner merges every change to what runs with the driver key.** The driver App's key can create and delete repositories in the test organisation and change this one. So the runner, the janitor, the `e2e*.yml` and `probe-*.yml` workflows, and every workflow that reads an environment's key are on the escalation paths as `always` ([`docs/qa/escalation-paths.md`](docs/qa/escalation-paths.md)): agents propose a change there, and the Owner decides.

## Tests

`npm ci && npm test` runs them on Vitest; CI runs them on every pull request. [`docs/qa/stack.md`](docs/qa/stack.md) lists the gates.

- `tests/escalation-paths.test.mjs` holds each pattern above on the `always` list.
- `tests/workflows.test.mjs` holds the harness's workflows to plan 0012 §5.2: no job that holds an App key runs someone else's code, each environment is named only by the jobs §5.2 lists and the probes, no `-job` workflow names a private key, and no workflow runs on a pull-request event with a secret, other than those Kanon's own lane callers map by name into their lane.
- `tests/telemetry.test.mjs` holds the harness's collector caller and its `sent with evidence` choice, and holds the runner, the scenarios and the `e2e*.yml` workflows to passing no `kanon init` flag that turns telemetry or sharing on, and to installing no collector.
