# Scenarios

Kanon's plan 0012 §4 makes a scenario data: a directory here, `scenarios/<scenario>/`, holding `scenario.json`, a `start/` tree and `steps.json`. [The harness's README](../README.md#scenarios) describes the format. This file lists the step vocabulary a `steps.json` is written in. The validator (`runner/validate.mjs`) refuses a scenario that breaks a rule of either, and the runner reads scenarios only through it. The scenarios themselves are listed in [the harness's README](../README.md#the-catalogue), and each has a README of its own: the first is [`deploy-rehearsal/`](deploy-rehearsal/README.md), plan 0012's step E5, step E6 adds the install family: [`install-review/`](install-review/README.md), [`install-build/`](install-build/README.md), [`install-full/`](install-full/README.md) and [`install-python/`](install-python/README.md), step E7 the upgrade family: [`upgrade-previous/`](upgrade-previous/README.md) and [`upgrade-previous-1/`](upgrade-previous-1/README.md), and step E12 the doctor-broken family: [`doctor-ruleset-rule/`](doctor-ruleset-rule/README.md), [`doctor-approval-off/`](doctor-approval-off/README.md) and [`doctor-id-token/`](doctor-id-token/README.md), and the `lane-check` family: [`lane-check-inexact-pin/`](lane-check-inexact-pin/README.md), [`lane-check-mixed-pin/`](lane-check-mixed-pin/README.md) and [`lane-check-secrets-inherit/`](lane-check-secrets-inherit/README.md).

## The rules every verb keeps

- **A closed set.** A step names one of the verbs below, and only the arguments that verb takes. A scenario that needs another verb adds it in a pull request, with its unit test. `runner/` is the Owner's to merge ([`docs/qa/escalation-paths.md`](../docs/qa/escalation-paths.md)).
- **One kind of segment.**
  - `kanon`: the verb runs Kanon's code at the release under test, fetched as an adopter fetches it (`npx --yes --package github:yedeya-labs/kanon#<release> kanon …`), in the `kanon` job, on its read-only token.
  - `act`: the verb writes to GitHub with the harness's own code, in the `act` job, and runs no code of Kanon's.
  - `either`: the verb only reads, and may sit in either kind of segment.

  The validator refuses a verb in the wrong kind of segment.
- **A verb that waits takes a `deadline`,** a whole number of minutes from 1 to 120. It polls with a backoff from 2 to 30 seconds until what it waits for holds, never sleeping a fixed time (plan 0012 §10). A deadline that passes fails the scenario.
- **An expectation reads a field, never prose** (§4.3). It names only a JSON field (by name or pointer), a finding id, or a marker from [`runner/known-markers.json`](../runner/known-markers.json), and compares it to a value. No argument takes text to match, and no pointer may pass through a field that holds free text, such as a finding's `message` or a comment's `body`.
- **Two substitutions, each in one place.** `steps.json` takes `{{repository}}` in `expect.api`'s `path`, and `{{release}}` in a `fields` entry's `equals` of `expect.init` and `expect.doctor` ([below](#substitutions-in-stepsjson)). The validator refuses either anywhere else, and any other.

## The verbs

A step is an object: `verb`, then the verb's arguments. A step's `name` is the name later steps use for the pull request, issue or run it makes or finds. Each verb is `runner/verbs/<verb>.mjs`, with its unit test against a stubbed `gh` in `tests/verbs-<kind>.test.mjs`.

| Verb | What it does | Segment | Waits |
|---|---|---|---|
| `kanon.init` | Runs `kanon init --json --yes --no-apps --consent no` with its `flags` (`--feature=full`, `--review-trigger=labelled`, `--sensitive-data`, …) in the job's clone. The CLI writes only to the clone. Keeps the document for `expect.init` and `repo.apply`. | `kanon` | no |
| `kanon.doctor` | Runs `kanon doctor --json` in the job's clone of the default branch, with `to: true` as `--to <release under test>`, and keeps the document and its exit code. | `kanon` | no |
| `kanon.at` | Runs `init` or `doctor` (`command`) at another `release`: `previous`, `previous-1` (Kanon's stable releases below the release under test) or a tag. It keeps the document as the two verbs above do. | `kanon` | no |
| `register.write` | Writes the App register's rows for `scenario.json`'s `apps` into the clone, with the release's own `cli/app-register.mjs` and the slugs in `runner/test-apps.json`: at the release under test, or at the `release` it names (`previous`, `previous-1` or a tag, as `kanon.at` takes it), for an install at an older release. It holds no key. | `kanon` | no |
| `pins.move` | Runs the release's `scripts/move-pins.mjs` on the clone, to the release under test. | `kanon` | no |
| `repo.apply` | Applies what the kept `init` document's findings name, with the harness's own code (decision 23 (b)). Its first call sets squash-only merging (`merge.settings`) and creates the release's labels from its `requirements.json` (`label.create`), the bucket milestones (`milestone.buckets`) and the ruleset (`ruleset.create`), as `K-ADOPT-1` steps 5 to 8 state them. `init`'s read-only token can't see the merge settings, so it doesn't name `merge.settings`: `provision` sets them before the first push instead (#36). Its second call adds the ruleset's required `Lane check` rule (`ruleset.require-check`). On a default branch with no commit, `init` names neither ruleset finding, but `ruleset.first-commit`: push the first commit, then run `init` again, which creates the ruleset (K-ADOPT-4). With `firstCommit: true`, on a step after that push, `repo.apply` takes `ruleset.first-commit` for the two findings that run would name, `ruleset.create` on its first call and `ruleset.require-check` on its second. The count starts again when a new `init` document is kept (by `kanon.init`, or `kanon.at` with `init`), so each `init` document gets at most a settings call and a `Lane check` call: an upgrade's `init` at the release under test gets its own, to create what the new release adds, such as a new label. A third call for one document is refused. | `act` | no |
| `bootstrap.end` | Ends bootstrap as Kanon's `docs/install.md` tells an adopter to once the review lane runs on the default branch (`K-ADOPT-6`), with the harness's own code (decision 23 (b)), in two `move`s. `record` writes `ended YYYY-MM-DD`, today, under `## Bootstrap` in the adoption record, in place of `init`'s `in bootstrap since` line (`K-LAYOUT-10`), and pushes it to the default branch: so it comes before `repo.apply` creates the ruleset. `approval` requires one approving review in the ruleset, dismissed when a new commit is pushed (`K-MERGE-6`), as doctor's fix for `ruleset.bootstrap-can-end` does. The validator refuses an `approval` with no earlier `record`, and either move twice. | `act` | no |
| `files.commit` | Commits the files of a `dir` of the scenario's (`from: scenario`), with `{{release}}` and `{{repository}}` filled in as `start/` takes them ([below](#substitutions-in-a-filescommit-directory)), or those the `kanon` segment left (`from: kanon`), as they are, and deletes the paths in `delete`, on `branch` or the default branch, and pushes. | `act` | no |
| `pr.open` | Opens a pull request from `head` into `base` (the default branch by default). | `act` | no |
| `pr.label` | Adds the labels in `add` to a pull request, and removes those in `remove`. | `act` | no |
| `pr.merge` | Merges a pull request, `via` the `front-door` (into the merge queue with `enqueuePullRequest` where one sets the base's strategy, otherwise squash, with auto-merge, or at once where the repository doesn't allow auto-merge) or as a `bypass` actor, and waits until it merged. | `act` | yes |
| `issue.open` | Opens an issue, with its `labels`. | `act` | no |
| `issue.label` | Adds the labels in `add` to an issue. | `act` | no |
| `workflow.dispatch` | Dispatches a `workflow`, with its `inputs`, on `ref` or the default branch. | `act` | no |
| `release.cut` | Merges the release pull request (labelled `autorelease: pending`), keeps it as `release`, and waits for the Release the test Releaser publishes. | `act` | yes |
| `deployment.await-approval` | Waits until a run's job is `waiting` on the `environment`. Then it cancels the run, and holds that job to ending `cancelled`, on every trigger: no person is asked anything (decision 9, amended 2026-10-20). | `act` | yes |
| `environment.create` | Creates the deployment environment `name` as plan 0010 §4 and §12 ask: its deployment refs the `tags` pattern alone, no administrator bypass, and with `reviewer: true` the Owner (`environmentReviewer` in `runner/settings.json`) as its required reviewer, with self-review prevented. `kanon init` creates no environment. | `act` | no |
| `ruleset.tags` | Creates the active tag ruleset `Release tags` on the `pattern`, with the creation, update and deletion rules doctor's `deploy.tag-ruleset` reads, letting the test Apps in `bypass` through. | `act` | no |
| `run.await` | Waits for a `workflow`'s run on an `event` and a commit (a `branch`'s head or a `pr`'s) to complete, and keeps it. | `either` | yes |
| `issue.await` | Waits for an issue no step opened, one a workflow under test files, by its `author` (an App's slug, `github-actions` for the workflow token) and its `labels`, never its title or body, and keeps the newest under `name` for `expect.issue`. | `either` | yes |
| `expect.init` | Holds the kept `init` document to a `status`, an `exitCode`, finding ids present (`findings`) and `absent`, and `fields` by pointer. A `fields` entry's `equals` may hold `{{release}}`. | `either` | no |
| `expect.doctor` | Holds the kept doctor document as `expect.init` does, and to the `unchecked` checks it allows: any other `unchecked` check fails it. With `blocking`, a list of finding ids, the findings whose `blocking` field is `true` must be exactly those ids: one more that blocks fails it, and so does a listed id reported as not blocking or not at all. `blocking: []` allows no blocking finding. A finding that blocks nothing is not counted. | `either` | no |
| `expect.run` | Holds a kept run to its `conclusion`, and its `jobs`, by name, to theirs. | `either` | yes |
| `expect.check` | Holds a commit's check run, or else its status, of a `name` to a `conclusion`. | `either` | yes |
| `expect.issue` | Holds an issue to its `state`, `labels`, `labelsAbsent`, `author` (an App's slug), and a known `marker` in a post, optionally `markerBy` an App. | `either` | yes |
| `expect.pr` | Holds a pull request as `expect.issue` holds an issue, with `merged` as a state, and looks for the marker in its reviews too. | `either` | yes |
| `expect.artifact` | Holds a kept run to an artifact of a `name`. | `either` | yes |
| `expect.api` | Makes one GET of the scenario repository's own API per try, a `path` under `repos/{{repository}}/`, and holds the value at a `pointer` to what it `equals`. The validator refuses any other path. | `either` | yes |

## Substitutions in steps.json

`start/` takes `{{release}}` and `{{repository}}` anywhere ([the harness's README](../README.md#scenarios)). `steps.json` takes each in one place only:

| Substitution | Where | Filled in with |
|---|---|---|
| `{{repository}}` | `expect.api`'s `path`, as its prefix `repos/{{repository}}/` | The scenario repository's `<owner>/<name>`. |
| `{{release}}` | A `fields` entry's `equals`, in `expect.init` and `expect.doctor`: the string, or a string in its list | The release under test, before comparing. |

So an expectation can say "pinned to the release under test", which no literal can, since the release differs per run:

```json
{ "verb": "expect.init", "status": "steps-left", "fields": [{ "pointer": "/pin", "equals": "{{release}}" }] }
{ "verb": "expect.doctor", "fields": [{ "pointer": "/releases/pins", "equals": ["{{release}}"] }, { "pointer": "/releases/pinned", "equals": "{{release}}" }] }
```

A document that pins any other release fails it. The validator refuses `{{release}}` anywhere else in `steps.json`, a `fields` entry's `pointer` and `expect.api`'s `equals` among them, and `{{repository}}` in `equals`.

## Substitutions in a files.commit directory

A directory `files.commit` commits `from: scenario` takes `start/`'s two substitutions, in its files and their paths: `{{release}}` and `{{repository}}`, filled in before the commit. A workflow's `${{ … }}` is not one, and a binary file is committed as it is. So a file committed after the install can pin the release under test, as every Kanon reference must: the `lane-check` family's correct caller does, `uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@{{release}}`. The validator refuses any other substitution in that directory, as it does in `start/`. Files `from: kanon` are Kanon's output, committed as they are.

## Doctor on the `kanon` job's token

The `kanon` job's token is read-only (decision 23 (b)). On it, doctor can't list the repository's secrets, so it leaves exactly one check `unchecked`, `secrets`, and exits 4 (`incomplete`): probe 19 measured that on `candidate-v0.41.0` ([`probes/README.md`](../probes/README.md), item 19). A scenario that runs `kanon.doctor` in a `kanon` segment therefore allows exactly `secrets` and expects exit 4:

```json
{ "verb": "expect.doctor", "status": "incomplete", "exitCode": 4, "unchecked": ["secrets"] }
```

Any other check `unchecked` fails that expectation, so "incomplete" can't pass for "healthy".

A doctor-broken scenario (plan 0012 §6.1) breaks one thing on purpose, and expects exactly that finding id, and no other blocking one. Doctor then exits 1 (`findings`), not 4: a blocking finding outranks a check that couldn't run, and `secrets` is still the one allowed `unchecked`. `blocking` holds the document to that one blocking finding, whatever finding that blocks nothing it also reports:

```json
{ "verb": "expect.doctor", "status": "findings", "exitCode": 1, "unchecked": ["secrets"], "findings": ["ruleset.rule-missing"], "blocking": ["ruleset.rule-missing"] }
```
