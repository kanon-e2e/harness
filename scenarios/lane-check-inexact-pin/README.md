# Lane check: an inexact pin

Kanon's plan 0012 step E12, the `lane-check` family (§6.1): an adopter edits the `apps-check` caller to follow Kanon's `main` branch, `@main`, in place of the exact release `init` pinned. The scenario installs Kanon's **Review** feature into a fresh repository as `install-review` does, at the release under test, and opens two pull requests that rewrite that one caller. `Lane check` must fail the one with the breakage, and pass the one that keeps the caller as `init` writes it.

`scenario.json`: family `lane`, tier `none`, Claude `none`, `judge` as its test App (the `review` feature's), and `gate: false`: a new scenario counts toward the release gate only after ten passes in a row (plan 0012 §10, decision 24). The pull request that turns it `true` changes only its `scenario.json` and its catalogue entry.

## The breakage

The file is `.github/workflows/apps-check.yml`, the caller `init` writes for Kanon's `apps-check` workflow. It runs only by hand (`workflow_dispatch`), so neither pull request starts a run of it beside CI's. Its two versions, in this directory:

- `broken/`: the caller with one line changed, `uses: yedeya-labs/kanon/.github/workflows/apps-check.yml@main`.
- `fixed/`: the caller as `init` writes it, pinned to `{{release}}` with `JUDGE_APP_ID` and `JUDGE_APP_PRIVATE_KEY` mapped by name.

The two differ in that line and a comment, and nothing else, so the red belongs to the breakage. `files.commit` fills in `{{release}}` as `start/` does ([`scenarios/README.md`](../README.md#substitutions-in-a-filescommit-directory)).

What lane-check holds (Kanon's `actions/lane-check/README.md`): **Every Kanon reference pins one exact version, the one lane-check runs at** (`K-ADOPT-11`). `main` is not an exact version, so lane-check reports it, and the repository's references now pin two versions, `{{release}}` and `main`. Why it matters to an adopter: `main` moves under the repository: the caller would run whatever Kanon's default branch holds, not the release the rest of the lanes run, and Dependabot proposes no upgrade for it.

Both versions were run once through Kanon's real lane-check at `candidate-v0.42.0`, over the tree `init` writes plus the App register: the broken one failed by exactly this rule, and the correct one passed.

## The steps

One phase. Every push to the default branch comes before the ruleset exists; after that, the scenario works on branches only.

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon` | `kanon.init` with `--feature=review`, `--review-trigger=labelled` and `--no-sensitive-data`, as `install-review` | |
| 1 | `kanon` | `register.write`: the App register's rows for `judge`. lane-check fails without them | |
| 1 | `kanon` | `expect.init` | As `install-review`: status `steps-left`, the findings `label.create`, `milestone.buckets` and `ruleset.first-commit`, and `/pin` equal to `{{release}}`. |
| 1 | `act` | `files.commit` from the `kanon` job, to the default branch, in one push | |
| 1 | `act` | `repo.apply` with `firstCommit`: the labels, the bucket milestones and the ruleset | |
| 1 | `act` | `run.await` for `ci.yml`'s run on the push | |
| 1 | `act` | `expect.check` | `Lane check` on the default branch's head concluded `success`: the clean install is green, so a red below is the breakage's. |
| 1 | `act` | `repo.apply` again: the ruleset's required `Lane check` rule | |
| 1 | `act` | `files.commit` of `broken/` on the branch `broken`, then `pr.open` `broken` | |
| 1 | `act` | `files.commit` of `fixed/` on the branch `fixed`, then `pr.open` `fixed`. Both pull requests run CI at once | |
| 1 | `act` | `run.await` for `ci.yml`'s `pull_request` run on `broken`'s head | |
| 1 | `act` | `expect.run` | The run concluded `failure`, and its job `Lane check` `failure`. |
| 1 | `act` | `expect.check` | `Lane check` on `broken`'s head concluded `failure`. |
| 1 | `act` | `run.await` for `ci.yml`'s `pull_request` run on `fixed`'s head | |
| 1 | `act` | `expect.run` | The run concluded `success`, and its job `Lane check` `success`. |
| 1 | `act` | `expect.check` | `Lane check` on `fixed`'s head concluded `success`. |

**What it can't hold.** lane-check's annotation names the rule it broke, but an expectation never reads prose (§4.3), and lane-check writes no marker. So the scenario holds the conclusion, and the pair of pull requests holds the cause: the only difference between the red one and the green one is the breakage. `tests/lane-check-scenarios.test.mjs` holds the two files to differ only there.

## What it creates

One public repository in `kanon-e2e`, `e2e-lane-check-inexact-pin-<run>-<attempt>`, holding:

- what `init` writes for the review feature, pinned to the release under test, and the App register's rows for `judge`;
- the release's labels, the bucket milestones, and the default branch's ruleset with its `Lane check` rule;
- two open pull requests, `broken` and `fixed`, never merged;
- `ci.yml`'s runs: one on the push, one on each pull request.

The repository is deleted when the scenario passes. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 10 minutes, an estimate until the first dispatch measures it: `provision`, one `kanon` job, one `act` job, and three CI runs of one short job each. The deadline is 45 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **People:** none.

Dispatch it on its own. `select=lane` names the whole `lane` family, which also holds `refuse-review-label` and the real-model `review-real`, so it would spend the Owner's subscription too:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=lane-check-inexact-pin
```

## When it is red

The failing job's summary names the first failure. What it usually means:

- **`expect.init`.** As `install-review`: `init` pinned another release, or reports other findings. Not this scenario's subject.
- **`expect.check` on the default branch.** lane-check refused the clean install: a finding against Kanon, which `install-review` reports too.
- **`expect.run` on `ci-broken`, `success` read.** lane-check passed the breakage: Kanon's pin rule no longer refuses a branch name, or no longer reads references in a non-lane caller.
- **`expect.run` on `ci-fixed`, `failure` read.** lane-check refused the caller as `init` writes it. Either Kanon changed the caller (compare `fixed/` with `appsCheckFile` in Kanon's `cli/callers.mjs` at the release, and follow it), or the check regressed.
- **`expect.check` after a green `expect.run`.** The check run's name changed: `ci.yml`'s job is no longer named `Lane check`, which the ruleset's rule needs too.
- **`run.await` timed out.** No `pull_request` run of `ci.yml` came: `init`'s `ci.yml` lost its `pull_request` trigger, or Actions was slow (`infra` when GitHub answered with an error).
