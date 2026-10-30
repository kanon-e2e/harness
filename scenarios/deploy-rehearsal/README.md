# The deploy rehearsal

Kanon's plan 0010 ended with D12: a person took one repository through the deploy lane by hand, release by release, at v0.40.0. This scenario is plan 0012's step E5: the same rehearsal, automated, run on every candidate and every nightly. It installs the deploy lane for `staging` then `production` in a fresh repository, cuts three releases through it, and holds each run to what the lane promises. It runs on GitHub alone: the hooks touch no cloud, and no credential is involved.

`scenario.json`: family `deploy`, tier `none`, Claude `none`, two test Apps, the Judge and the Releaser, and `gate: true`: it burnt in with ten passes in a row, scheduled or dispatched (Kanon plan 0012 decision 24), so its result counts toward the release gate on every candidate.

## What the repository holds

`start/` is the repository's first commit, with `{{release}}` filled in:

| File | What it is |
|---|---|
| `.github/actions/build/action.yml` | The build hook. It writes `dist/hello.txt`, holding the release's tag, into the lane's output directory. |
| `.github/actions/deploy/action.yml` | The deploy hook. With `probe: 'true'`, it answers the trust probe with `refused` for every listed environment, since no cloud credential exists to obtain. Otherwise it checks that the artifact's `dist/hello.txt` holds the release's tag. |
| `.github/actions/smoke/action.yml` | The smoke hook. It passes. |
| `.github/workflows/release.yml` | The caller of Kanon's release workflow, pinned `@{{release}}`, mapping the Releaser's two secrets by name. A Release the Releaser publishes starts the deploy lane, where one made with the workflow token wouldn't. |
| `release-please-config.json`, `.release-please-manifest.json`, `version.txt` | release-please's `simple` type, from `0.0.0`, tagging `vX.Y.Z`. |

`kanon init --deploy-environments=staging,production` writes the rest: the deploy caller `deploy.yml`, pinned to the release, the adoption record's `## Deploy` section, and `ci.yml`, whose push run the lane's gate waits for. `init` writes a hook stub only where no file is, so the hooks above stay.

Before the first release, the `act` job sets the repository up as plan 0010 §4 and §12 ask an adopter to:

- **`staging`**, an environment whose deployment refs are the release tags alone (`v*.*.*`, a tag rule, no branch rule). Administrators can't bypass it.
- **`production`**, the same, with the Owner (`environmentReviewer` in [`runner/settings.json`](../../runner/settings.json)) as its required reviewer, and self-review prevented.
- **`Release tags`**, an active tag ruleset on `v*.*.*` with the creation, update and deletion rules, which the Releaser bypasses. The major tag `v0`, which Kanon's release workflow moves, is outside the pattern.

`register.write` writes the App register's rows (`docs/qa/agent-identities.md`) for the Judge and the Releaser, as `kanon apps --reuse` would. Without the register, `lane-check` fails CI on every commit ("the App register is missing (K-LAYOUT-6)"), and the deploy lane's gate refuses a red commit (`ci-red`, K-SHIP-8). The Judge is there because the review lane `init` installs reads the Reviewer's slug from it. `repo.apply` also does what `init` leaves to a person: squash-only merging, which Kanon's release workflow requires, the labels and the milestones.

**The rehearsal runs with no default-branch ruleset.** The repository has no commit when `init` runs, so `init` reports `ruleset.first-commit`, not `ruleset.create`, and `repo.apply` applies only the findings the document names. The scenario doesn't set `repo.apply`'s `firstCommit` flag, which would count `ruleset.first-commit` as `ruleset.create`, so no ruleset protects the default branch: the front-door merges and `release.cut` run without one. Its ten burn-in passes ran the same way.

## The three releases

Each release is a pull request merged through the front door, then the release pull request release-please opens, merged by `release.cut`, then the Release the Releaser publishes, which starts `deploy.yml`.

| Release | Its change | What the scenario expects |
|---|---|---|
| `v0.1.0` (`feat:`) | A file, `src/hello.txt` | `production`'s deploy job waits for its reviewer (`deployment.await-approval`). The run lists `release / gate`, `release / probe`, `release / build`, `release / record` and `release / report`, all `success`. It lists `staging / deploy`, the reference deploy `init` declares, and `staging / record` and `staging / report`, all `success`. Then `production / record` and `production / report`, `success`. |
| `v0.1.1` (`fix:`) | The smoke hook fails | The run concludes `failure`: `staging / deploy` succeeds, since the deploy hook did and the smoke check is `continue-on-error`, and `staging / verdict` fails the call on the smoke check's outcome (Kanon plan 0013 §7.1, from Kanon 0.43.0 on). `staging / record` and `staging / report` succeed. The report job files staging's issue, which `issue.await` finds by its author, `github-actions[bot]`, and its labels, `bug` and `sev:medium`. `expect.issue` holds it `open`. |
| `v0.1.2` (`fix:`) | The smoke hook passes again | Staging's deploy succeeds, and the report job closes that issue: `expect.issue` holds it `closed`. Production waits for its reviewer again, and nobody answers: deleting the repository ends the run. |

Between the first release and the second, `kanon doctor` runs on the `kanon` job's read-only token. `expect.doctor` holds every one of doctor's 18 `deploy.*` findings absent. It allows two checks `unchecked`: `secrets`, as probe 19 measured, and `deploy-secrets`, the organisation secrets doctor can't list without Secrets: read. Doctor runs after the first run because `deploy.trust-unproven` reads the trust probe's line from a completed run of the lane.

## The approval: cancelled on every run

`deployment.await-approval` sits alone in phase 2, so that it has an `act` job's whole 30 minutes.

Every run, a candidate's included, cancels the first release's run as soon as `production / deploy` is waiting. The job must then end `cancelled`; anything else fails the scenario. No person is asked anything. The Owner decided this on 2026-10-20, amending decision 9: the Owner's approval on a candidate's run had to come inside the step's 25 minutes, and two runs of `candidate-v0.42.0` went red on it, one approved half a minute early and one too late (#81, #84). That a person can approve a deploy the test Releaser published was measured by probe 7 (Kanon #968), and Kanon's own deploys ask the Owner for it on every release.

## Phases

| Phase | `kanon` job | `act` job |
|---|---|---|
| 1 | `kanon.init` | Push what `init` wrote; `repo.apply`; the two environments and the tag ruleset; the first release. |
| 2 | (nothing) | Wait for production's reviewer; hold the first run's jobs. |
| 3 | `kanon.doctor`, `expect.doctor` | The second release and its issue; the third release, which closes it. |

## What it creates

One public repository in `kanon-e2e`, `e2e-deploy-rehearsal-<run>-<attempt>`, holding the following:

- the two environments;
- the tag ruleset (and no default-branch ruleset);
- three Releases and their tags;
- the moved `v0` tag;
- staging's issue;
- about a dozen workflow runs.

The repository is deleted when the scenario passes. When it fails, the repository is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 45 minutes on a nightly, an estimate until the first dispatch measures it. That is three `kanon` jobs, three `act` jobs and three releases' runs in the scenario repository. The scenario's deadline is 100 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **People:** none. GitHub still notifies the Owner, as `production`'s reviewer, each time a run waits on it.

## When it is red

The `act` job's summary names the first failure. What it usually means:

- **`deployment.await-approval` passed its deadline.** The first release's run never reached `production`. Look at its gate, which waits for `ci.yml`'s push run at the release's commit and fails if `Lane check` failed there, and at `staging / deploy`.
- **`production / deploy` ended other than `cancelled`.** The lane ran production's job without the reviewer, or the cancel didn't stop it. The environment's protection didn't hold: look at the environment first.
- **`expect.run` on the first release.** A job is missing or failed. A missing name means the lane's job names moved, which a Kanon change should say. A failed `release / probe` means the trust probe's judge refused the hook's answer.
- **`release.cut` passed its deadline.** release-please opened no release pull request, or the Releaser published no Release. The release workflow's guard fails on anything but squash-only merging. A tag ruleset that doesn't let the Releaser through stops the tag.
- **`expect.run` on the second release.** `staging / deploy` read `failure` and `staging / verdict` is not in the run: the release under test predates Kanon 0.43.0, whose deploy job fails on the smoke check itself. `staging / deploy` read `failure` in a run that lists `staging / verdict`: the deploy hook failed, not the smoke check.
- **`issue.await` on the second release.** The report job filed no issue, or not under `github-actions[bot]` with `bug` and `sev:medium`. That is a finding against the lane's report job (plan 0010 D7).
- **`expect.issue` `closed` on the third.** Staging succeeded, but its report didn't close the issue.
- **`expect.doctor`.** A `deploy.*` finding means the repository doesn't hold what plan 0010 §12 asks. Either the setup above changed, or doctor's check did. Another check `unchecked` means the `kanon` job's token reads less than it did.
