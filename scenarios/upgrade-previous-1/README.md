# Upgrade: from previous-1

Kanon's plan 0012 step E7 (harness #42): an adopter on the stable release before the latest one below the release under test moves to the release under test, skipping a release. The scenario installs Kanon's **Full pipeline** into a fresh repository at that older release, with the older release's own `init`, the way an adopter did then. It then upgrades the repository as the upgrade skill would, with the harness's verbs in the skill's place (§4.2), and checks that doctor then finds it healthy, with every Kanon reference pinned to the release under test and only it.

`previous-1` is the stable release of Kanon before `previous`, the latest one below the release under test (`resolveRelease` in [`runner/lib/kanon.mjs`](../../runner/lib/kanon.mjs)): `v0.40.1` at `candidate-v0.41.0`, `v0.40.0` at `v0.40.2`. Its sibling, [`upgrade-previous`](../upgrade-previous/README.md), starts one stable release later. The two together say an adopter needn't take every release.

`scenario.json`: family `upgrade`, tier `none`, Claude `none`, `author` and `judge` as its test Apps (the `full` feature's Apps), and `gate: false`. It counts toward the release gate only after burn-in (step E9) and the Owner's decision.

## What the repository holds

`start/` is one file, a `README.md` that names the scenario, the release and the repository (`{{release}}` and `{{repository}}` filled in). The repository is otherwise empty, as a new adopter's was.

## The flags

`kanon.at` and `kanon.init` always run `kanon init --json --yes --no-apps --consent no`: no Apps created, telemetry and sharing declined (decision 8). Both add the same flags, so the upgrade's `init` answers as the install's did:

- `--feature=full`, so the upgrade moves every lane's caller.
- `--review-trigger=labelled`: the Reviewer reviews a pull request once it is labelled `review:please`.
- `--no-sensitive-data`: the adoption record's `## Data` section declares no sensitive material.

The scenario leaves out the `--chat=none` that [`install-full`](../install-full/README.md) gives. The `v0.40` releases' `init` doesn't know `--chat`, and refuses it as an unknown argument. At the release under test, `--yes` answers `none` anyway when there's no notify hook, so leaving the flag out changes nothing there.

**The App register is written at the older release too** (`register.write` with `release: previous-1`). At `candidate-v0.41.0`, Kanon's `cli/app-register.mjs` and the Apps' roles and permissions in `requirements.json` are the same at `v0.40.1`, `v0.40.2` and the candidate, so for that release pair the rows are the same either way, and the upgrade has no row to move. A later pair whose rows differ needs that edit by hand, and the final doctor names it.

## The steps

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon` | `kanon.at` with `release: previous-1` and `command: init`, with the flags above: the older release's own `init` | It keeps the `init` document, with `release` the older release. The run's state after this job (the artifact `e2e-state-upgrade-previous-1-kanon-1`) records it. |
| 1 | `kanon` | `register.write` with `release: previous-1`: the register's rows for `author` and `judge` | |
| 1 | `act` | `files.commit` from the `kanon` job, to the default branch, in one push | |
| 1 | `act` | `bootstrap.end` with `record`: under `## Bootstrap` in the adoption record, `ended <today>` in place of the `in bootstrap since` line the older `init` wrote (K-LAYOUT-10), in a second push before the ruleset exists | |
| 1 | `act` | `repo.apply` with `firstCommit`: the labels and the bucket milestones the older `init` names, and the ruleset it would create on its run after this push (it ran on a default branch with no commit, so it named `ruleset.first-commit`) | |
| 1 | `act` | `workflow.dispatch` of `apps-check.yml`, then `run.await` for its run | |
| 1 | `act` | `expect.run` | The run concluded `success`, with `apps / Author` and `apps / Judge` each `success`. |
| 1 | `act` | `run.await` for `ci.yml`'s run on the push | |
| 1 | `act` | `expect.check` | `Lane check` on the default branch's head concluded `success`, at the older release. |
| 1 | `act` | `repo.apply` again, with `firstCommit`: the ruleset's required `Lane check` rule | |
| 2 | `kanon` | `kanon.doctor` with `to: true`: doctor at the release under test, `--to` it, on the older install | |
| 2 | `kanon` | `expect.doctor` | `/releases/to` equals `{{release}}`: the document lists what the release under test needs. Only `secrets` is unchecked. It holds no status: the install is still at the older release. |
| 2 | `kanon` | `pins.move`: Kanon's own `scripts/move-pins.mjs`, at the release under test, moves every pin to it | |
| 2 | `kanon` | `kanon.init` at the release under test, with the same flags | It writes the files the new release brings and keeps the declarations. Its document names the GitHub settings left to apply: the upgrade skill's step 5, taken from `init`. |
| 2 | `act` | `files.commit` from the `kanon` job, on the branch `upgrade`, then `pr.open` | |
| 2 | `act` | `run.await` for `ci.yml`'s run on the pull request | |
| 2 | `act` | `expect.check` | `Lane check` on the pull request's head concluded `success`, at the release under test. |
| 2 | `act` | `pr.merge` through the front door | |
| 2 | `act` | `expect.pr` | The pull request is `merged`. |
| 2 | `act` | `repo.apply`, twice: what the new `init` document names | The first creates what the new release adds, such as a new label. The second adds the `Lane check` rule if it is still missing. |
| 2 | `act` | `bootstrap.end` with `approval`: one required approving review in the ruleset, dismissed when a new commit is pushed (K-MERGE-6). It comes only now: once the ruleset requires an approval, the upgrade's pull request would need the Reviewer's, which a scenario with no model can't give. With phase 1's record, it ends bootstrap as Kanon's `docs/install.md` tells an adopter to (K-ADOPT-6). | |
| 3 | `kanon` | `kanon.doctor` on the default branch | |
| 3 | `kanon` | `expect.doctor` | Status `incomplete`, exit code 4, and only `secrets` unchecked: the `kanon` job's read-only token can't list the secrets (probe 19). `incomplete` means nothing blocking was found. `/releases/pins` equals `["{{release}}"]` and `/releases/pinned` equals `{{release}}`. The findings `pin.mixed`, `ruleset.bootstrap-can-end` and `ruleset.approval-off` are absent. |

`{{release}}` in an expectation is filled in with the release under test before comparing ([`scenarios/README.md`](../README.md#substitutions-in-stepsjson)).

**`repo.apply` runs four times, two for each `init` document.** Its count starts again when a new `init` document is kept, here by phase 2's `kanon.init` ([`scenarios/README.md`](../README.md#the-verbs)). At `candidate-v0.41.0`, the labels in `requirements.json` are the same as at `v0.40.1` and `v0.40.2`, so the third call creates no label there. It is there for the release pair that adds one.

**Run it at the newest unpromoted candidate, or at a stable release.** At a candidate, `init` pins the candidate, because the stable tag doesn't exist yet. Once the candidate is promoted, `init` prefers the stable tag. The files it writes then pin `vX.Y.Z` beside the candidate that `pins.move` wrote, and the final doctor reads `pin.mixed`.

## Why the upgrade merges through a pull request

Phase 1 leaves the default branch behind its ruleset, the way an adopter's is. The ruleset requires a pull request and lets no one bypass it, and its second `repo.apply` adds the required `Lane check`. So the upgrade can't be pushed to `main`. It goes on a branch, through a pull request, and merges through the front door, as an adopter's upgrade does.

Auto-merge is off in the scenario repository, as `kanon init` leaves it. `pr.merge`'s front door then merges at once, and can't wait for the required check (#33). So the scenario puts a `run.await` for `ci.yml` on the pull request, and an `expect.check` that `Lane check` succeeded, before `pr.merge`, as #33 suggests. Once #33 is fixed, the `run.await` can go, though the `expect.check` stays, since it says that `Lane check` passes at the release under test.

## What it creates

One public repository in `kanon-e2e`, `e2e-upgrade-previous-1-<run>-<attempt>`, holding the following:

- the callers of the full feature's lanes, a stub `project-setup` hook, the `apps-check` and `ci.yml` callers, and the adoption record and declarations, first at the older release, then moved to the release under test, plus whatever new files the release under test's `init` writes;
- the App register's rows for `author` and `judge`;
- the release's labels, the bucket milestones, and the default branch's ruleset with its `Lane check` rule and, from the end of phase 2, one required approving review, dismissed on push;
- the adoption record's `ended` line under `## Bootstrap`, in a second commit to the default branch before the ruleset exists;
- one pull request, `upgrade`, merged;
- the workflow runs: `apps-check`, `ci.yml`'s run on each of phase 1's two pushes, and `ci.yml`'s run on the pull request. The merge's push starts one more `ci.yml` run, which no step waits for.

The repository is deleted when the scenario passes. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 25 minutes, an estimate until the first dispatch measures it: `provision`, three `kanon` jobs, three `act` jobs, and the three runs it waits for. The scenario's deadline is 90 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **People:** none.
- **Scheduled lanes:** the Full pipeline writes callers for scheduled lanes (the Overseer, the digests, the sweeps). A schedule that fires while the repository lives runs there, and each run takes a job from the organisation's limit of about 6 at once (`jobsAtOnce` in [`runner/settings.json`](../../runner/settings.json)). **Not measured yet**, as for `install-full`.

## When it is red

The failing job's summary names the first failure. What it usually means:

- **`kanon.at`.** There are fewer than two stable releases below the release under test, so none is `previous-1`, or the older `init` refused a flag. A release that refuses one of the flags above changed its `init`: drop the flag here only with the reason.
- **Phase 1's `expect.run`, `expect.check` or second `repo.apply`.** The older release didn't install cleanly. Check whether `install-full` is red at that release too. A finding against the older release is not one against the release under test.
- **Phase 2's `expect.doctor` on `/releases/to`.** Doctor at the release under test didn't check against it: its `--to` regressed.
- **`pins.move`.** `scripts/move-pins.mjs` failed, or is missing from the release under test.
- **Phase 2's `expect.check` on `Lane check`.** `lane-check` at the release under test refused the upgraded tree. Most often a pin `move-pins.mjs` didn't move, or a file the new release needs that `init` didn't write.
- **`pr.merge`.** The ruleset refused the merge: the pull request lacks something the ruleset requires (#33 if it's the check).
- **`bootstrap.end` with `record`.** The adoption record has no `in bootstrap since` line under `## Bootstrap`: the older release's `init` wrote the record in another layout (K-LAYOUT-10), and the verb follows the newest.
- **`bootstrap.end` with `approval`.** No ruleset named as `init` names it, or it has no pull request rule.
- **The final `expect.doctor` on `ruleset.bootstrap-can-end`.** The ruleset still requires no approving review, or the record says `in bootstrap since` again: one of `bootstrap.end`'s moves didn't land, or phase 2's `init` rewrote the adoption record. `init` keeps an existing record today (`projectsOwn`), so a rewrite is a finding against the release under test. **On `ruleset.approval-off`:** the record says bootstrap ended, but doctor reads no required approval.
- **The final `expect.doctor`, on a finding.** **Most often, the release pair needs a hand edit**, and two releases apart there are more of them than one apart: one that neither `move-pins.mjs` nor `init` makes, which the upgrade skill's step 4 lists for a person, such as a digest caller's `DIGEST_WEBHOOK`. That is a real finding about the upgrade. Fix it in Kanon, or in the scenario with the reason written here. Never relax the expectation.
- **The final `expect.doctor` on `/releases/pins`, `/releases/pinned` or `pin.mixed`.** Some file still pins the older release, or pins another one: `move-pins.mjs` missed a reference, or `init` wrote one pinned elsewhere (a promoted candidate, above).
- **The final `expect.doctor` on `unchecked`.** Another check couldn't run: the `kanon` job's token reads less than it did, or doctor needs more.
