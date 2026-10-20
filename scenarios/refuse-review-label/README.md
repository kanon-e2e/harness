# Gate refusal: a review label from outside the register

Kanon's plan 0012 step E12, the gate refusals (§6.1): the lanes' own admission rules, on real events. This one is the first: **a label applied by an identity outside the App register starts nothing.** It installs Kanon's **Review** feature as [`install-review`](../install-review/README.md) does, at the release under test, with the Judge, then opens a pull request and labels it `review:please` as the harness's driver App. The review lane's run must start, refuse the label at its membership gate, and do nothing else: no Reviewer token, no review, no comment.

`scenario.json`: family `lane`, tier `none`, Claude `none`, `judge` as its test Apps (the `review` feature's Apps in the release's `requirements.json`), and `gate: false`: it is new, so its result changes nothing on a candidate's run until it has passed ten runs in a row, scheduled or dispatched (Kanon plan 0012 §10, decision 24).

## Who applies the label

Every step in an `act` segment writes to GitHub with the act token, which the `mint` job mints from the driver App's key (`docs/jobs.md`). So the label is applied by the driver App, `<driver>[bot]`. The driver is not in the scenario repository's App register: `register.write` writes rows only for the Apps `scenario.json` lists, here the Judge. An App is never a collaborator, so for a login ending `[bot]` only the register decides (Kanon's `scripts/lane-gate.mjs`, `K-AGENT-45`), and the driver is refused. That is the honest case of the plan's "an identity outside the register": a real App, installed on the repository with write access, that the register doesn't name. The harness has no identity that is a person outside the register, and none is needed: a person's label is judged by their repository permission, not by the register.

## What the repository holds

`start/` is one file, a `README.md` that names the scenario, the release and the repository (`{{release}}` and `{{repository}}` filled in). The repository is otherwise empty, as a new adopter's is. `change/` is the pull request's one file, `docs/note.md`.

## The flags

`kanon.init` always runs `kanon init --json --yes --no-apps --consent no`: no Apps created, telemetry and sharing declined (decision 8). The scenario adds the same flags as [`install-review`](../install-review/README.md):

- `--feature=review`.
- `--review-trigger=labelled`: the Reviewer reviews a pull request once it is labelled `review:please`.
- `--no-sensitive-data`.

## The steps

Phase 1 is [`install-review`](../install-review/README.md)'s phase 1, step for step: a clean install, `apps-check` and `Lane check` green, bootstrap ended. Its doctor phase is left out: the install family holds that. Phase 2 is the refusal.

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon`, `act` | `install-review`'s phase 1 | What `install-review` expects. |
| 2 | `act` | `files.commit` of `change/` on the branch `docs-note` | |
| 2 | `act` | `pr.open` from `docs-note`, as the driver | |
| 2 | `act` | **The refusal:** `pr.label` adds `review:please`, as the driver | |
| 2 | `act` | `expect.api` on the review caller's `pull_request_target` runs for the branch `docs-note` | `/total_count` is 2: the run for the pull request's `opened` event and the run for the label. It waits until both exist, so the next step can't keep the `opened` run. |
| 2 | `act` | `run.await` for `agent-review.yml`'s `pull_request_target` run on the pull request's head | The newest such run, the label's, completes. |
| 2 | `act` | `expect.run` | The run concluded `success`. `review / filter` ran and concluded `success`: the label is `review:please`, so the filter admits the event, and its first step, the membership gate, refuses the driver and exits 0 with `member=false`. `review / notify-unlabeled` and `review / review` are `skipped`: both need `member` to be `true`. |
| 2 | `act` | `expect.pr` | The pull request is `open` and still labelled `review:please`. |

**Why `review / review` skipped proves the refusal.** On a member's `review:please`, the filter's later steps read the Reviewer's login and decide `review=true`, and `review / review` runs: it mints the Judge's token and starts the agent. This repository has no `CLAUDE_CODE_OAUTH_TOKEN`, so the run would then fail. A `skipped` review job beside a `success` filter is the gate's refusal, and nothing else ends a label event that way.

**Why the count comes first.** Both events land on the same head, and `run.await` keeps the newest run. Right after the label, GitHub may not have created the label's run yet, and `run.await` would keep the `opened` run, already complete. The count makes it wait until the label's run exists. The `opened` run is a different refusal: the driver's pull request is a bot's, and the filter's `if` declines it before the gate.

**What it doesn't hold.** CI's completion on the pull request also starts the review lane (`workflow_run`), and its gate judges whoever applied the review label, the driver again. That run's record carries no field that ties it to this pull request, so the scenario doesn't wait for it.

## What it creates

One public repository in `kanon-e2e`, `e2e-refuse-review-label-<run>-<attempt>`, holding what `install-review`'s holds, plus:

- the branch `docs-note` and its open pull request, labelled `review:please`;
- the review lane's runs on that pull request, each refused or declined, and `ci.yml`'s run on it.

The repository is deleted when the scenario passes. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 15 minutes, an estimate until the first dispatch measures it: `provision`, one `kanon` job, two `act` jobs, and the runs it waits for. The scenario's deadline is 60 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **Model:** none. The gate refuses before any token is minted, and the repository holds no Claude token, so even a gate that admitted the label couldn't spend anything.
- **People:** none.

## When it is red

The failing job's summary names the first failure. A failure in phase 1 is an install failure: read [`install-review`'s list](../install-review/README.md#when-it-is-red), which takes the same steps. In phase 2, what it usually means:

- **`expect.run` on `review / review` not `skipped`, or the run `failure`.** The gate admitted an App outside the register. That is a finding against Kanon's membership gate (`K-AGENT-45`). If the driver App has been added to the register, the scenario is wrong, not Kanon.
- **`expect.run` on `review / filter` `skipped`.** The filter's `if` declined the label before the gate ran: Kanon changed which labels start a review.
- **`expect.run` on `review / filter` `failure`.** The gate failed by name instead of refusing: it couldn't read the register from the default branch, or an API call failed. Its step summary says which.
- **`expect.run` on a job not in the run.** Kanon renamed a job of the review lane, or the caller's job is no longer `review`.
- **`expect.api` on `/total_count`.** A third run reached the branch, or one of the two never started. GitHub starts no run for an event made with a workflow token, but the act token is an App's, so both events should start one.
- **`run.await` passed its deadline.** No run of `agent-review.yml` on `pull_request_target` reached the pull request's head: the caller lost that trigger, or the label never landed.
