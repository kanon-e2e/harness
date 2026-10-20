# Real model: the Reviewer reviews a pull request

Kanon's plan 0012 step E10, the real-model tier (§6.2): the first scenario that runs a model lane. It installs Kanon's **Review** feature as [`install-review`](../install-review/README.md) does, at the release under test, with the Author and the Judge, and opens a one-line documentation pull request. The test Author labels it `review:please`, and the Reviewer reviews it on the Owner's subscription token. The scenario expects only what doesn't depend on the model (decision 11): the run completed, the lane's telemetry row was uploaded with its cost under the lane's ceiling, and a verdict of either kind was posted by the Judge, read by the Reviewer's role marker.

`scenario.json`: family `lane`, tier `model`, Claude `subscription`, `author` and `judge` as its test Apps, a deadline of 120 minutes, and `gate: false`: it is new, so its result changes nothing on a candidate's run until it has passed ten runs in a row (Kanon plan 0012 §10, decision 24), and it joins the gate only once the ledger's measured cost fits (§9). Its `authorLabel` names the pull request's branch, `docs-note`, and the label, `review:please`.

## Who applies the label

The review lane starts only on a label applied by a member or a registered agent App (Kanon's `scripts/lane-gate.mjs`, `K-AGENT-45`). The driver App, which makes every other event here, is neither: [`refuse-review-label`](../refuse-review-label/README.md) holds that refusal. So after phase 1, `e2e.yml`'s `author-label` job, a pair of its own, mints the test Author's token for this one repository (Issues and Pull requests write) and applies `review:please` with `gh`, as an adopter's Implementer labels its own pull request. The Author is in the App register (`register.write`), so the gate admits it. That job runs no harness code and no Kanon code (`K-AGENT-50`) ([`docs/jobs.md`](../../docs/jobs.md)).

## What the repository holds

`start/` is one file, a `README.md` that names the scenario, the release and the repository (`{{release}}` and `{{repository}}` filled in). `change/` is the pull request's one file, `docs/note.md`. `model-key` writes `CLAUDE_CODE_OAUTH_TOKEN` before the first phase, once the real-model ledger admitted the scenario.

## The flags

`kanon.init` always runs `kanon init --json --yes --no-apps --consent no`: no Apps created, telemetry and sharing declined (decision 8). The scenario adds `install-review`'s flags and one more:

- `--feature=review`, `--review-trigger=labelled`, `--no-sensitive-data`;
- `--claude-auth=subscription`: the review caller maps `CLAUDE_CODE_OAUTH_TOKEN`, the secret `model-key` writes.

## The steps

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon`, `act` | `install-review`'s phase 1 | What `install-review` expects. |
| 1 | `act` | `files.commit` of `change/` on the branch `docs-note`, then `pr.open` from it, as the driver | |
| 1 | `act` | `run.await` for `ci.yml`'s `pull_request` run on the pull request | It completes, so the label that follows isn't deferred to CI's completion. |
| — | `author-label` | **The label:** the test Author applies `review:please` | |
| 2 | `act` | `expect.api` on the review caller's `pull_request_target` runs for `docs-note` | `/total_count` is 2: the `opened` run, which the filter declines for a bot's pull request, and the label's. It waits until both exist, so the next step keeps the label's. |
| 2 | `act` | `run.await` for `agent-review.yml`'s `pull_request_target` run on the pull request | The label's run completes: the review, on the model. |
| 3 | `act` | `expect.run` | The run concluded `success`, with `review / filter` and `review / review` `success`. |
| 3 | `act` | `expect.row` | The run's `kanon-telemetry-review-<run>-<attempt>` row is a version-2 `review` row whose `total_cost_usd` is at most $30, the lane's `--max-budget-usd`. Its cost is kept as the result's `costUsd`, the ledger's history. `outcome: unavailable` reads `infra`. |
| 3 | `act` | `expect.pr` | A post or review by `kanon-e2e-judge` carries the Reviewer's role marker (`role:reviewer`): a verdict, whichever it is. |

**Why the row comes before the verdict.** A step that fails ends the scenario, and the steps after it are skipped. The row is read first so its cost is recorded whatever the verdict step finds: the ledger reads only recorded costs.

## What it creates

One public repository in `kanon-e2e`, `e2e-review-real-<run>-<attempt>`, holding what `install-review`'s holds, plus:

- the secret `CLAUDE_CODE_OAUTH_TOKEN`;
- the branch `docs-note` and its open pull request, labelled `review:please` by the Author, with the Reviewer's review;
- the review lane's runs on it, and `ci.yml`'s.

The repository is deleted when the scenario passes, with its token secret. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Model:** one Reviewer run on a one-line pull request. Its cost is unmeasured until the first run; the lane's ceiling is $30. The ledger starts it only on the Owner's dispatch, alone, until it has a recorded cost, and afterwards only when its expected cost, the largest of its last ten recorded costs times 1.5, fits the run's $2 ([`docs/jobs.md`](../../docs/jobs.md#the-real-model-ledger)). On the subscription token that cost is Claude Code's reckoning, not a bill; it comes out of the subscription's usage limits.
- **Time:** about 30 to 45 minutes, an estimate until the first dispatch measures it. The deadline is 120 minutes.
- **Minutes:** the repositories are public, so their runs cost nothing (probe 6).
- **People:** the first run is the Owner's dispatch.

Dispatch it, alone:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=review-real
```

## When it is red

The failing job's summary names the first failure. A failure in phase 1 is an install failure: read [`install-review`'s list](../install-review/README.md#when-it-is-red). After it, what it usually means:

- **`expect.api` on `/total_count`.** The label's run never started. Check the `author-label` job: the mint failed (the Author App's installation or key), or no open pull request from `docs-note` was found. If the job labelled the pull request, the gate may have refused the Author: the register lacks its rows.
- **`run.await` passed its deadline.** The review took longer than 25 minutes, or the label was deferred to a CI run that hadn't finished.
- **`expect.run` on `review / review` `skipped`.** The gate refused the label: the Author isn't on a role's row of the register, or Kanon changed who may label.
- **`expect.run` on `review / review` `failure`.** The agent failed. Its run's summary says why. A missing `CLAUDE_CODE_OAUTH_TOKEN` reads `infra` before this, at the `act` job's precondition.
- **`expect.row`.** No row uploaded (Kanon renamed the artifact or the lane), or the cost was past $30. `infra` with `unavailable`: the model was never reached, so it is retried, not failed.
- **`expect.pr` on the marker.** The Reviewer posted nothing with its role marker, or posted as another App.
