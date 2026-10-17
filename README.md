# harness

The harness is [Kanon](https://github.com/yedeya-labs/kanon)'s end-to-end tier. It tests Kanon from outside, the way an adopter meets it: it creates throwaway repositories in the `kanon-e2e` organisation, installs a Kanon release there, runs scenarios against it, and reports whether the release passed. Kanon's [plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) is the design. [`probes/README.md`](probes/README.md) lists the platform assumptions the plan rests on, how each was measured, and what was found.

**It is an adopter itself.** It runs Kanon's full pipeline, as any adopter does: the agent lanes, the review and the Merger, `lane-check` in CI, and Dependabot's Kanon pin bumps. It cuts its own releases through Kanon's release lane, and only because they add coverage: a repository that lives for months exercises a run of releases, pin bumps and upgrades, which a throwaway repository can't. Its end-to-end runs don't come from those releases. They run from `main`, so a fix to the harness reaches the next run at once.

**The Owner merges every change to what runs with the driver key.** The driver App's key can create and delete repositories in the test organisation and change this one. So the runner, the janitor, the `e2e*.yml` and `probe-*.yml` workflows, and every workflow that reads an environment's key are on the escalation paths as `always` ([`docs/qa/escalation-paths.md`](docs/qa/escalation-paths.md)): agents propose a change there, and the Owner decides.

## Scenarios

A scenario is data (plan 0012 §4): a directory `scenarios/<scenario>/`, which the runner reads only through the validator, `runner/validate.mjs`. `node runner/validate.mjs` validates every directory under `scenarios/`, and the tests do too.

```
scenarios/<scenario>/
  scenario.json   what the scenario is
  start/          the tree laid down as the scenario repository's first commit
  steps.json      up to three phases, each a `kanon` segment then an `act` segment of verbs
```

**`scenario.json`** holds these fields and no others:

| Field | Value |
|---|---|
| `id` | The directory's name: lowercase, digits and hyphens, at most 40 characters. |
| `family` | `lane`, `install`, `doctor`, `upgrade` or `deploy`. |
| `tier` | `none` or `model`. |
| `gate` | Whether it counts toward the release gate, a boolean. A new scenario starts `false`, and turns `true` after ten consecutive scheduled passes. |
| `apps` | The test Apps the scenario repository gets: any of `author`, `judge`, `releaser`. |
| `claude` | `none` or `subscription`: whether the scenario repository needs the real-model token. |
| `deadlineMinutes` | The whole scenario's deadline, at most 120. |

**`start/`** is copied as it is, regular files only, with two substitutions and no others: `{{release}}`, the release under test, and `{{repository}}`, the scenario repository's `<owner>/<name>`. A workflow's `${{ … }}` is not a substitution, and a binary file is copied untouched.

**`steps.json`** is `{ "phases": [ … ] }`, one to three phases, because a scenario runs in at most three pairs of jobs (§5.2). Each phase is `{ "kanon": [ … ], "act": [ … ] }`, a segment for the `kanon` job, then one for the `act` job. A step is `{ "verb": …, …its arguments }`.

**The vocabulary is closed** (§4.2). Each verb belongs to one kind of segment:

- **`kanon` segments only:** the verbs that run Kanon's code, at the release under test, as an adopter fetches it: `kanon.init`, `kanon.doctor`, `kanon.at`, `register.write`, `pins.move`.
- **`act` segments only:** the verbs that write to GitHub with the harness's own code: `repo.apply`, `files.commit`, `pr.open`, `pr.label`, `pr.merge`, `issue.open`, `issue.label`, `workflow.dispatch`, `release.cut`, `deployment.await-approval`.
- **Either:** the verbs that only read: `run.await`, `expect.init`, `expect.doctor`, `expect.run`, `expect.check`, `expect.issue`, `expect.pr`, `expect.artifact`, `expect.api`.

A verb that waits takes a `deadline` in minutes, and polls. [`scenarios/README.md`](scenarios/README.md) lists every verb: what it does, its arguments, and whether it waits.

**Expectations read fields, finding ids and known markers, never prose** (§4.3). An expectation names only a JSON field (by name or pointer), a finding id, or a marker from the harness's list of known markers, and compares it to a value. No expectation takes free text to match, and no expectation reads a field that holds free text, such as a finding's `message` or a comment's `body`. The list of known markers is [`runner/known-markers.json`](runner/known-markers.json): only markers Kanon already writes for its own reasons, such as the release-PR guard's `<!-- kanon-release-pr-guard … -->` and the Reviewer's role marker. `expect.api` reads only the scenario repository's own API, a path under `repos/{{repository}}/`.

**Adding a verb.** A scenario that needs a verb the vocabulary lacks adds it in a pull request, with its unit test against a stubbed `gh`:

1. Write `runner/verbs/<verb>.mjs`. Declare its segment kind, whether it waits, and its arguments.
2. List it in `runner/vocabulary.mjs`.
3. Add its row to [`scenarios/README.md`](scenarios/README.md).
4. Add a `describe('<verb>', …)` block to the `tests/verbs-<kind>.test.mjs` file for its kind.

Everything under `runner/`, the verbs, the validator and the known markers included, runs with the driver's token. So every such pull request is the Owner's to merge ([`docs/qa/escalation-paths.md`](docs/qa/escalation-paths.md)).

## Tests

`npm ci && npm test` runs them on Vitest; CI runs them on every pull request. [`docs/qa/stack.md`](docs/qa/stack.md) lists the gates.

- `tests/escalation-paths.test.mjs` holds each pattern above on the `always` list.
- `tests/scenario-format.test.mjs` validates every directory under `scenarios/`, and holds the validator to the format above: each rule it refuses, by name.
- `tests/vocabulary.test.mjs` holds the vocabulary to plan 0012 §4.2: the closed set, each verb's segment kind, the deadline and backoff of every verb that waits, Kanon's code run only through `npx` at the release, the known markers, and the two tables of verbs.
- `tests/verbs-kanon.test.mjs`, `tests/verbs-act.test.mjs` and `tests/verbs-read.test.mjs` test each verb on a stubbed `gh`, `npx` and `git`.
- `tests/workflows.test.mjs` holds the harness's workflows to plan 0012 §5.2: no job that holds an App key runs someone else's code, each environment is named only by the jobs §5.2 lists and the probes, no `-job` workflow names a private key, and no workflow runs on a pull-request event with a secret, other than those Kanon's own lane callers map by name into their lane.
