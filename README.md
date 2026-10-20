# harness

The harness is [Kanon](https://github.com/yedeya-labs/kanon)'s end-to-end tier. It tests Kanon from outside, the way an adopter meets it: it creates throwaway repositories in the `kanon-e2e` organisation, installs a Kanon release there, runs scenarios against it, and reports whether the release passed. Kanon's [plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) is the design. [`probes/README.md`](probes/README.md) lists the platform assumptions the plan rests on, how each was measured, and what was found.

**It is an adopter itself.** It runs Kanon's full pipeline, as any adopter does: the agent lanes, the review and the Merger, `lane-check` in CI, and Dependabot's Kanon pin bumps. It cuts its own releases through Kanon's release lane, and only because they add coverage: a repository that lives for months exercises a run of releases, pin bumps and upgrades, which a throwaway repository can't. Its end-to-end runs don't come from those releases. They run from `main`, so a fix to the harness reaches the next run at once.

**It sends its telemetry and its upstream findings to Kanon, as an adopter that opts in.** Its collector's caller, `.github/workflows/telemetry.yml`, sends its lanes' run data to Kanon's hosted store ([Kanon's sharing docs](https://github.com/yedeya-labs/kanon/blob/main/docs/sharing.md)), and its adoption record says ``- **Upstream findings:** `sent with evidence` ``, so what its Overseer finds about Kanon itself is sent with its evidence, after the scrub. Its rows are a long-lived adopter's real run data, and its install tests the hosted path from a fresh repository. **Its scenario repositories send neither** ([plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) §4.2, decision 8): the install there declines telemetry and sharing, and installs no collector. `tests/telemetry.test.mjs` holds both.

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
| `gate` | Whether it counts toward the release gate, a boolean. A new scenario starts `false`, and turns `true` after its burn-in: ten passes in a row ([Runs](#runs)). |
| `apps` | The test Apps the scenario repository gets: any of `author`, `judge`, `releaser`. |
| `claude` | `none` or `subscription`: whether the scenario repository needs the real-model token. |
| `deadlineMinutes` | The whole scenario's deadline, at most 120. |

**`start/`** is copied as it is, regular files only, with two substitutions and no others: `{{release}}`, the release under test, and `{{repository}}`, the scenario repository's `<owner>/<name>`. A workflow's `${{ … }}` is not a substitution, and a binary file is copied untouched.

**`steps.json`** is `{ "phases": [ … ] }`, one to three phases, because a scenario runs in at most three pairs of jobs (§5.2). Each phase is `{ "kanon": [ … ], "act": [ … ] }`, a segment for the `kanon` job, then one for the `act` job. A step is `{ "verb": …, …its arguments }`.

**The vocabulary is closed** (§4.2). Each verb belongs to one kind of segment:

- **`kanon` segments only:** the verbs that run Kanon's code, at the release under test, as an adopter fetches it: `kanon.init`, `kanon.doctor`, `kanon.at`, `register.write`, `pins.move`.
- **`act` segments only:** the verbs that write to GitHub with the harness's own code: `repo.apply`, `bootstrap.end`, `files.commit`, `pr.open`, `pr.label`, `pr.merge`, `issue.open`, `issue.label`, `workflow.dispatch`, `release.cut`, `deployment.await-approval`, `environment.create`, `ruleset.tags`.
- **Either:** the verbs that only read: `run.await`, `issue.await`, `expect.init`, `expect.doctor`, `expect.run`, `expect.check`, `expect.issue`, `expect.pr`, `expect.artifact`, `expect.api`.

A verb that waits takes a `deadline` in minutes, and polls. [`scenarios/README.md`](scenarios/README.md) lists every verb: what it does, its arguments, and whether it waits.

**Expectations read fields, finding ids and known markers, never prose** (§4.3). An expectation names only a JSON field (by name or pointer), a finding id, or a marker from the harness's list of known markers, and compares it to a value. No expectation takes free text to match, and no expectation reads a field that holds free text, such as a finding's `message` or a comment's `body`. The list of known markers is [`runner/known-markers.json`](runner/known-markers.json): only markers Kanon already writes for its own reasons, such as the release-PR guard's `<!-- kanon-release-pr-guard … -->` and the Reviewer's role marker. `expect.api` reads only the scenario repository's own API, a path under `repos/{{repository}}/`. `steps.json` takes two substitutions, each in one place: `{{repository}}` in `expect.api`'s path, and `{{release}}` in a `fields` entry's `equals` of `expect.init` and `expect.doctor`, so an expectation can say "pinned to the release under test".

**Adding a verb.** A scenario that needs a verb the vocabulary lacks adds it in a pull request, with its unit test against a stubbed `gh`:

1. Write `runner/verbs/<verb>.mjs`. Declare its segment kind, whether it waits, and its arguments.
2. List it in `runner/vocabulary.mjs`.
3. Add its row to [`scenarios/README.md`](scenarios/README.md).
4. Add a `describe('<verb>', …)` block to the `tests/verbs-<kind>.test.mjs` file for its kind.

Everything under `runner/`, the verbs, the validator and the known markers included, runs with the driver's token. So every such pull request is the Owner's to merge ([`docs/qa/escalation-paths.md`](docs/qa/escalation-paths.md)).

## The catalogue

Each scenario's own README says what it sets up, what each step expects, what it creates and costs, and what a red result usually means. Each entry here shows its `gate` value, which the pull request that turns it `true` updates.

**`deploy-rehearsal`** ([`scenarios/deploy-rehearsal/`](scenarios/deploy-rehearsal/README.md), family `deploy`, no model, `gate: true`). Kanon's deploy lane, end to end, in a repository with `staging` then `production`. It repeats plan 0010's D12 rehearsal, done once by hand at v0.40.0, on every candidate and every nightly. It cuts three releases:

1. The first goes through the gate, the trust probe and the build, then deploys to staging, and every `record` and `report` job runs. `production` then waits for its reviewer. The run must list the job names the reference deploy declares.
2. The second has a failing smoke check: the lane must file staging's issue.
3. The third succeeds, and must close that issue.

Doctor must report no `deploy.*` finding.

The approval differs by trigger. On a candidate's run, the scenario files the Owner's approval request in this repository and waits for the Owner to approve `production`: one approval per candidate (decision 9). On a nightly or a dispatch, it cancels the run at production's wait, and holds production's deploy job to ending `cancelled`. Dispatch it on its own:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=v0.40.2 -f select=deploy-rehearsal
```

**The install family** (plan 0012 step E6, family `install`, no model, `gate: false` until burn-in). Four scenarios install Kanon into a fresh repository the way an adopter does: `kanon init` for one feature at the release under test, the App register, one push of what `init` wrote, then what `init` leaves to a person (the labels, the bucket milestones, the ruleset), `apps-check`, the ruleset's `Lane check` rule once `ci.yml`'s push run reports it, then the end of bootstrap, as Kanon's `docs/install.md` tells an adopter once the review lane runs on the default branch: `bootstrap.end` writes `ended YYYY-MM-DD` under `## Bootstrap` in the adoption record, and requires one approving review in the ruleset, dismissed on push. Each holds `init`'s document to `steps-left` with the findings it reports on a repository with no commit: `label.create` and `milestone.buckets`, which the harness applies in a person's place, and `ruleset.first-commit`, for which it creates the ruleset `init` would create on its run after the first push. It holds `apps-check` to `success` for every App it lists, and `Lane check` to `success`. Doctor, on the `kanon` job's read-only token, must then read `incomplete` with exit code 4 and only `secrets` unchecked: nothing blocking, whatever finding that blocks nothing it reports. Neither `ruleset.bootstrap-can-end` nor `ruleset.approval-off` may be reported. Each is pinned to the release under test: `init`'s `/pin`, doctor's `/releases/pinned` and every ref in `/releases/pins` must be it, and only it. Run them at the newest unpromoted candidate or at a stable release: a promoted candidate's `init` pins the stable tag instead, and they fail.

- **`install-review`** ([`install-review/`](scenarios/install-review/README.md), `gate: true`). The **Review** feature, from an empty tree, with the Judge.
- **`install-build`** ([`install-build/`](scenarios/install-build/README.md), `gate: true`). The **Review + build** feature, from an empty tree, with the Author and the Judge.
- **`install-full`** ([`install-full/`](scenarios/install-full/README.md), `gate: true`). The **Full pipeline**, from an empty tree, with the Author and the Judge. Its scheduled lanes can fire while the repository lives.
- **`install-python`** ([`install-python/`](scenarios/install-python/README.md), `gate: true`). The **Review + build** feature into Kanon's Python fixture project (`pyproject.toml`, `src/`, `tests/` and its `project-setup` hook, taken at `candidate-v0.41.0`), with the Author and the Judge.

Dispatch the family:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=install
```

**The upgrade family** (plan 0012 step E7, family `upgrade`, no model, `gate: false` until burn-in). Two scenarios check that an adopter on an older stable release can move to the release under test. Each installs Kanon's **Full pipeline** at the older release with that release's own `init` (`kanon.at`), and its App register at the same release, then takes the install family's steps: one push, the adoption record's `ended` line in a second push, the settings `init` leaves, `apps-check`, `Lane check` on the push and the ruleset's `Lane check` rule. It then upgrades as the upgrade skill would, without running the skill (§4.2): doctor `--to` the release under test lists what that release needs, and must check against it (`/releases/to`); Kanon's own `scripts/move-pins.mjs` moves every pin (`pins.move`); `init` at the release under test, with the same flags, writes the files the new release brings. The upgrade merges through a pull request whose `Lane check` passed, since the ruleset now exists, and `repo.apply` applies what the new `init` document names. Only then does the ruleset require one approving review, ending bootstrap: earlier, the upgrade's pull request would have needed one, which no model gives here. Doctor, on the `kanon` job's read-only token, must then read `incomplete` with exit code 4 and only `secrets` unchecked, every pin the release under test, and neither `pin.mixed`, `ruleset.bootstrap-can-end` nor `ruleset.approval-off`. A release pair that needs an edit neither `move-pins.mjs` nor `init` makes fails there, by its finding.

- **`upgrade-previous`** ([`upgrade-previous/`](scenarios/upgrade-previous/README.md)). From `previous`, the latest stable release below the release under test (`v0.40.2` at `candidate-v0.41.0`), to the release under test.
- **`upgrade-previous-1`** ([`upgrade-previous-1/`](scenarios/upgrade-previous-1/README.md)). From `previous-1`, the stable release before that (`v0.40.1` at `candidate-v0.41.0`), to the release under test.

Dispatch the family:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=upgrade
```

## Runs

**A scenario's life** (plan 0012 §5.1). `provision` creates a fresh public repository, `e2e-<scenario>-<run>-<attempt>`, empty, with the scenario's test Apps' secrets and the `kanon-e2e` topic. Each phase is then a `kanon` job, which runs Kanon's code at the release under test in a clone with a read-only token and writes nothing to GitHub, and an `act` job, which pushes what Kanon wrote and does the rest with the harness's own code. The first `act` job lays `start/` as the repository's first commit. The `act` job that learns the result ends the repository. [`docs/jobs.md`](docs/jobs.md) lists every job, which secret each holds and why, and the sizing.

**Three triggers, never a pull request** (§7). The **poll**, every 15 minutes, runs the latest candidate that has no `kanon-e2e` check run from the Reporter. It re-runs a candidate whose check run completed `neutral` over an hour ago, and gives one candidate at most six runs. The **nightly**, once a day, runs the latest candidate if one is newer than the latest stable release, else the stable. It runs only when Kanon's `main` moved since the last nightly, or when none has run for seven days. A **dispatch** runs an exact release. A run spends the organisation's minutes and the Apps' keys, and what it tests is Kanon's release, not a change to this repository, so nothing runs on a pull request.

**One run at a time.** `plan` stops a run while another run is in flight, before any repository is created. A nightly gives way to a candidate's run: its `plan` ends "skipped: a candidate's run covers tonight". It records nothing, so the next night runs if `main` still differs. What it loses is that night's run of `main`'s release: the candidate's run tests the candidate, which is usually that same code. The poll waits for its next tick. A dispatch stops, and says why.

**Pass, fail, infra.** A scenario reads `fail` when an expectation was false, or a deadline passed. Its repository is kept 24 hours, archived, with the `kanon-e2e-failed` topic, for a person to look at. It reads `infra` when GitHub, a token, or the harness's own preconditions failed: no finding about Kanon, and never a pass. It reads `skipped` when the runner refused to start it, with the reason in `skipped`: `budget` from the real-model ledger (E10). The hourly janitor deletes whatever a run left behind.

**The gate rule** (plan 0012 §8.2). `verdict` decides over the scenarios that count. On a candidate's run, those are the scenarios with `gate: true`, read from the catalogue at the run's commit, never from a result. A `gate: false` scenario is listed in the summary with its result, and changes nothing. On a nightly or a dispatch, every planned scenario counts. The verdict is `pass` only when every scenario that counts passed. It is `fail` when one read `fail` or `skipped`, and `infra-only` when nothing failed but one read `infra` or left no result. A candidate's run with no `gate: true` scenario is `fail`, "no scenario gates yet", never green on nothing. A candidate's check run completes `success`, `failure` or `neutral` to match, and the poll re-runs a `neutral` one after an hour. Kanon's gate reads the check run, and the `verdict` job's own conclusion, never the run's: [`docs/jobs.md`](docs/jobs.md#what-kanons-gate-reads) lists what it reads, and how.

**Burn-in** (§10, the Owner's rule of 2026-10-18). A new scenario starts `gate: false`, so it can't block a release. It earns `gate: true` with ten passes in a row, counted over the runs of `e2e.yml` on `main`, oldest first, from its last change to its `steps.json` or `start/`:

- A run that planned the scenario against a candidate, or against the latest stable release when it started, counts one more pass when the scenario read `pass`, whatever started it: the poll, the nightly or a dispatch. Any other result breaks the run of passes: `fail`, `infra`, `skipped`, or no result at all.
- A run whose `plan` stopped (it gave way, was held, or another run was in flight) neither counts nor breaks. Nor does a run that didn't plan the scenario, a run against an older stable release, or a run before the change.

`node runner/burn-in.mjs <scenario>` reads those runs' markers and results from their artifacts, and Kanon's releases, through `gh`. It prints a Markdown table of every run that counts or breaks, then the current run of passes, and exits 0 at ten or more, else 1. It writes nothing and holds no key, but it needs a token: an artifact's download answers `401` without one. Each scenario turns `true` in its own pull request, which changes only its `scenario.json` and its entry above, and holds that table as it printed. A scenario that gates is never set aside: while it is broken, releases wait until it is fixed.

**The red issue** (§8.3). Only a candidate's run reads or writes it, and only `verdict` does, with the workflow's own token. A nightly or a dispatch writes only its summary.

- **Filed** when a candidate's verdict isn't `pass`: one issue, `e2e: candidate-vX.Y.Z is red`. It lists each gating scenario that didn't pass, with its result, its first failure, its kept repository (archived, alive 24 hours) and the run.
- **Edited** by each later run of the same candidate, which adds its own run. `verdict` finds the issue by a marker on its body's first line, never one quoted below it, among the open issues `github-actions[bot]` opened, never by its title. The marker records whether a run ever read `fail`.
- **Closed** by a green run only when every run in it was `infra-only`. An issue that holds a `fail` stays open: a person closes it, with the cause. Until then, every run of that candidate answers `fail`, so its check run is `failure`, even when all its scenarios passed. The only way past a red gate is a fix and a new candidate.

**The `the Reporter can't post` issue.** When `start` can't create the check run (a rotated key, a lost installation), no scenario runs, the run fails, and `verdict` files `e2e: the Reporter can't post`. While it is open, a later run whose `start` failed adds itself to it. The next candidate's run whose `start` succeeded closes it.

**Dispatching a run.** Actions → `e2e` → Run workflow, with `release`, an exact `vX.Y.Z` or `candidate-vX.Y.Z`. `select` takes one scenario's id or one family. With the whole catalogue, a candidate's dispatch is a candidate's run: it posts the check run, and counts toward the six. Re-run a run with "Re-run all jobs": each token is minted per attempt, and a job handed an earlier attempt's token refuses it by name.

**Reading a red run.** For a candidate, start at its red issue, which the check run on Kanon's commit links. Each run in it lists the gating scenarios that didn't pass, with each one's first failure, and links the run and any kept repository. For a nightly or a dispatch, start at `verdict`'s summary: each scenario's result, and whether it counted. Then open the scenario's `act` job whose summary names the first failure: the phase, the segment, the step, and the expectation's message. Each `act` and `kanon` job's summary lists every step's outcome and duration. A `fail`'s repository is still there, archived, for 24 hours. `infra` means the run says nothing about Kanon: the poll re-runs a candidate's `neutral` check run after an hour; a green run's `verdict` closes an `infra`-only red issue.

## Tests

`npm ci && npm test` runs them on Vitest; CI runs them on every pull request. [`docs/qa/stack.md`](docs/qa/stack.md) lists the gates.

- `tests/escalation-paths.test.mjs` holds each pattern above on the `always` list.
- `tests/scenario-format.test.mjs` validates every directory under `scenarios/`, and holds the validator to the format above: each rule it refuses, by name.
- `tests/vocabulary.test.mjs` holds the vocabulary to plan 0012 §4.2: the closed set, each verb's segment kind, the deadline and backoff of every verb that waits, Kanon's code run only through `npx` at the release, the known markers, and the two tables of verbs.
- `tests/verbs-kanon.test.mjs`, `tests/verbs-act.test.mjs` and `tests/verbs-read.test.mjs` test each verb on a stubbed `gh`, `npx` and `git`.
- `tests/deploy-rehearsal.test.mjs` holds `scenarios/deploy-rehearsal/` to its issue's acceptance criteria (#26). Those are its three releases and what each expects, the environments and the tag ruleset before the first, production's wait, the run's job names, and every `deploy.*` finding held absent.
- `tests/install-scenarios.test.mjs` holds the four install scenarios to their issues' acceptance criteria (#41, #59): each `scenario.json`, the order of the steps, the end of bootstrap before doctor, what each expectation holds, every pin held to `{{release}}`, and what `install-python`'s `start/` took from Kanon's fixture and left out.
- `tests/upgrade-scenarios.test.mjs` holds the two upgrade scenarios to their issue's acceptance criteria (#42): each `scenario.json`, the install at the older release through `kanon.at` and `register.write`'s `release`, the upgrade's steps in order, the merge through a pull request, the end of bootstrap after it (#59), and the final doctor held to `{{release}}` with no `pin.mixed`.
- `tests/workflows.test.mjs` holds the harness's workflows to plan 0012 §5.2: no job that holds an App key runs someone else's code, each environment is named only by the jobs §5.2 lists and the probes, no `-job` workflow names a private key, no workflow runs on a pull-request event with a secret, other than those Kanon's own lane callers map by name into their lane, and `e2e.yml`'s `verdict` holds `issues: write` through its workflow token and no key.
- `tests/e2e-workflows.test.mjs` holds `e2e.yml` and its pairs to plan 0012 §5.2: the jobs, their order and conditions, each pair's mint and token, the read-only `kanon` token, an `act` job that runs no Kanon code, and every matrix's max-parallel and every job's timeout held to `runner/settings.json`.
- `tests/runner.test.mjs` tests the runner a segment at a time on a stubbed `gh` and `npx` and a real `git`, each `git` call stubbable: pass, fail and infra, the retries of `gh` and `git`, the state, and how the repository ends.
- `tests/artifact.test.mjs` holds the `act` job to taking the `kanon` job's tree as data: a hostile tree runs nothing, reads nothing outside it, and pushes nothing.
- `tests/plan.test.mjs` tests `plan`'s decisions: the poll, the nightly, the dispatch, and one run at a time.
- `tests/burn-in.test.mjs` tests `runner/burn-in.mjs`'s count on a stubbed `gh`: what counts, what breaks, and what does neither, such as a run that gave way or one against an older stable release.
- `tests/verdict-report.test.mjs` holds `verdict` and `report` to plan 0012 §8.2 and §8.3 (#40), on fixtures. It covers: the gating scenarios on a candidate's run and every scenario elsewhere; `gate` read from `plan`, never from a result; `skipped: budget` failing the gate; "no scenario gates yet". It holds the red issue's filing, editing and closing by its marker, a quoted marker that never passes for one, a green run that never closes a `fail` and answers `fail` while one is open, and the `the Reporter can't post` issue. It holds `verdict.json`'s fields and the exit status, and `report`'s conclusion, its summary's links, and its retry. It also holds what Kanon's gate reads: the check run's fields and `start`'s name.
- `tests/sizing.test.mjs` and `tests/janitor.test.mjs` hold the sizing and the janitor's cut-offs to `runner/settings.json`, and the janitor to deleting only what it may.
- `tests/telemetry.test.mjs` holds the harness's collector caller and its `sent with evidence` choice, and holds the runner, the scenarios and the `e2e*.yml` workflows to passing no `kanon init` flag that turns telemetry or sharing on, and to installing no collector.
