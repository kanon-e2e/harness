# Gate refusal: a release whose CI is red

Kanon's plan 0012 step E12, the gate refusals (§6.1): the lanes' own admission rules, on real events. This one is the third: **plan 0010's deploy gate refuses a release whose CI is red** (`ci-red`, `K-SHIP-8`). It installs the deploy lane for `staging` then `production` as [`deploy-rehearsal`](../deploy-rehearsal/README.md) does, with the project's own tests in `ci.yml`. It merges a change that breaks those tests, cuts a release from it, and holds the deploy lane's run to stopping at its gate: nothing built, nothing deployed, and staging's issue filed.

`scenario.json`: family `deploy`, tier `none`, Claude `none`, two test Apps, the Judge and the Releaser, and `gate: false`: it is new, so its result changes nothing on a candidate's run until it has passed ten runs in a row, scheduled or dispatched (Kanon plan 0012 §10, decision 24).

## What the repository holds

`start/` is [`deploy-rehearsal`](../deploy-rehearsal/README.md)'s first commit, with three more files, `{{release}}` filled in:

| File | What it is |
|---|---|
| `.github/workflows/ci.yml` | The project's CI, as an adopter keeps one: Kanon's `Lane check` job, written as `kanon init` writes it and pinned to the release, beside the project's own `Tests` job, which runs `test.sh`. `init` keeps a `ci.yml` the repository has, and writes no `lane-check.yml` beside it, since this one's job reports `Lane check`. |
| `test.sh` | The project's tests: `src/greeting.txt` must hold `hello`. |
| `src/greeting.txt` | `hello`. |
| `.github/actions/build/`, `deploy/`, `smoke/` | The rehearsal's hooks. The gate refuses before any of them runs, but with them the install is one that would deploy: only CI is wrong. |
| `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`, `version.txt` | The rehearsal's release setup: Kanon's release workflow with the Releaser's secrets, release-please's `simple` type from `0.0.0`. |

`regression/` is the change that breaks the tests: `src/greeting.txt` holding `good day`.

## The flags

`kanon.init` always runs `kanon init --json --yes --no-apps --consent no` (decision 8). The scenario adds the rehearsal's flags: `--feature=review`, `--review-trigger=labelled`, `--no-sensitive-data` and `--deploy-environments=staging,production`.

## The steps

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon` | `kanon.init` with the flags above, then `register.write`: the App register's rows for `judge` and `releaser` | |
| 1 | `act` | `files.commit` from the `kanon` job, `repo.apply`, `environment.create` for `staging` and for `production` with its reviewer, `ruleset.tags`: the rehearsal's setup, with no default-branch ruleset, since `repo.apply` sets no `firstCommit` | |
| 1 | `act` | `run.await` for `ci.yml`'s push run on the install | |
| 1 | `act` | `expect.run` | `success`, with `Lane check` and `Tests` `success`: CI is green before the change, so the red that follows is the change's. |
| 2 | `act` | `files.commit` of `regression/` on the branch `regression`, `pr.open`, `pr.merge` through the front door | It merges: no default-branch ruleset exists, so no check is required, as in [the rehearsal](../deploy-rehearsal/README.md#what-the-repository-holds). |
| 2 | `act` | `release.cut` | release-please's pull request merges, and the Releaser publishes `v0.1.0`, which starts `deploy.yml`. |
| 3 | `act` | `run.await` for `ci.yml`'s push run on the default branch's head, the release's commit | |
| 3 | `act` | `expect.run` | **The red CI:** `failure`, with `Lane check` `success` and `Tests` `failure`. |
| 3 | `act` | `run.await` for `deploy.yml`'s `release` run | |
| 3 | `act` | `expect.run` | **The refusal:** the run concluded `failure`. `release / gate` is `failure`. `release / probe` and `release / build` are `skipped`, since they need the gate. `release / record` and `release / report` are `success`: a run that stops before any environment writes one row and files on the first environment's issue. `staging` and `production`, the caller's environment jobs, are `skipped`. |
| 3 | `act` | `issue.await` and `expect.issue` | The report job filed staging's issue, `open`, by `github-actions[bot]`, labelled `bug` and `sev:medium`: staging is the first environment, and not production. |

**Why the refusal is `ci-red`.** The gate refuses by code, in order: `draft` or `no-release`, `not-default-branch`, `declaration-mismatch`, then `ci-red` or `ci-timeout` (Kanon's `scripts/deploy-gate.mjs`). Here the first three hold by construction, as they do in the rehearsal, whose gate passes on the same setup: the Releaser published the release (`release.cut` checks), its commit is the default branch's head, and the caller and the record's `## Deploy` list are the ones `init` wrote together. CI's run on that commit completed, so it isn't `ci-timeout`, and it is red, which the step before holds. What's left is `ci-red`.

**What it doesn't read.** The code itself, `ci-red`, is written in three places: the gate job's outputs, which the API doesn't return; its annotation and step summary, which are prose; and the row artifact, `kanon-deploy-row-<run>-<attempt>-1`, as its `refusal` field. No verb reads inside an artifact yet. A verb that holds a field of a JSON file in a kept run's artifact would let this scenario hold `refusal` to `ci-red` directly. Adding it is a change under `runner/`, the Owner's to merge.

## What it creates

One public repository in `kanon-e2e`, `e2e-refuse-deploy-ci-red-<run>-<attempt>`, holding the following:

- the two environments and the tag ruleset (and no default-branch ruleset);
- one Release, `v0.1.0`, and its tag, and the moved `v0` tag;
- staging's issue;
- the runs of `ci.yml` (green, then red), of the release workflow, and the deploy lane's refused run.

The repository is deleted when the scenario passes. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 25 minutes, an estimate until the first dispatch measures it: `provision`, one `kanon` job, three `act` jobs, one release. The scenario's deadline is 75 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **People:** none. The run never reaches `production`, so its reviewer is never asked.

## When it is red

The failing job's summary names the first failure. What it usually means:

- **`expect.run` on the install's CI.** `Lane check` failed: `lane-check` refused the install, or the `ci.yml` in `start/` no longer matches what `init` writes. `Tests` failed: `test.sh` or `src/greeting.txt` changed.
- **`release.cut` passed its deadline.** As in [the rehearsal](../deploy-rehearsal/README.md#when-it-is-red): no release pull request, or no Release from the Releaser. If Kanon's release workflow now refuses a red default branch, the scenario must cut its release before the change.
- **`expect.run` on the release's CI, `Tests` `success`.** The regression didn't reach the release's commit.
- **`expect.run` on `release / gate` `success`.** **The gate let a red commit through:** a finding against Kanon's deploy lane (`K-SHIP-8`). Look at the gate's step summary for what it read as CI's run.
- **`expect.run` on `release / probe` or `release / build` not `skipped`, or `staging` not `skipped`.** Something ran after a failed gate.
- **`expect.run` on a job not in the run.** Kanon renamed a job of the deploy lane, or `init`'s caller names its environment jobs otherwise.
- **`issue.await` passed its deadline.** The report job filed nothing for a refusal at the gate, or not as `github-actions[bot]` with `bug` and `sev:medium`.
- **`run.await` on `deploy.yml` passed its deadline.** The Release started no run: it wasn't the Releaser's, or the caller lost its `release` trigger.
