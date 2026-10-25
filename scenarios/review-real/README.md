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
| 2 | `act` | `run.await` for `agent-review.yml`'s `pull_request_target` run on the pull request, with `actor: author` | The run the Author's label started completes: the review, on the model. It is kept by its `triggering_actor`, the Author's bot login, not as the newest run: the Reviewer labels the pull request as it works (`agent:reviewer`, `sev:*`), and each of its labels starts a newer run on the same head that the filter skips in seconds. So the wait doesn't depend on how many label runs there are (harness #104). |
| 3 | `act` | `expect.row` | The run's `kanon-telemetry-review-<run>-<attempt>` row is a version-2 `review` row whose `total_cost_usd` is at most $30, the lane's `--max-budget-usd`. Its cost is kept as the result's `costUsd`, the ledger's history. `outcome: unavailable` reads `infra`. With no row, it reads `review / review` (its `job`): `skipped` fails at once. |
| 3 | `act` | `expect.run` | The run concluded `success`, with `review / filter` and `review / review` `success`. |
| 3 | `act` | `expect.pr` | A post or review by `kanon-e2e-judge` carries the Reviewer's role marker (`role:reviewer`): a verdict, whichever it is. |

**Why the row comes first** (harness #105). A step that fails ends the scenario, and the steps after it are skipped. The row is read before the run's conclusion and the verdict, so its cost is recorded whatever they find, a failed review included: the ledger reads only recorded costs, and a scenario whose failures recorded none would look cheaper than it is. The lane uploads its row even when the agent fails (Kanon's `agent-finish`, `if: always()`), unmeasured until the first failed review. A run the gate refused uploads none: its `review / review` is `skipped`, so `expect.row`, which names that job as its `job`, reads the skip and fails at once, saying the job was skipped, rather than waiting out its 5 minutes. So the refusal is still the first failure, and it reads as one.

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

- **`run.await` passed its deadline.** No run the Author started reached the pull request's head: check the `author-label` job (the mint failed, on the Author App's installation or key, or it found no open pull request from `docs-note`). Or the review took longer than 25 minutes, or the label was deferred to a CI run that hadn't finished. Its message names who started the runs it saw.
- **`expect.row` fails at once: `review / review` was skipped.** No row is uploaded, so this is the first failure, not `expect.run`'s. The message names the jobs beside it, `review / filter` first among them; read the skip by the filter's conclusion (#122):
  - `review / filter` `success`: the gate refused the label. The Author isn't on a role's row of the register, or Kanon changed who may label.
  - `review / filter` `failure`, `cancelled` or `skipped`: the filter didn't succeed, and GitHub skips a job whose `needs` didn't succeed. It is not a refusal: the filter's own log in the run says why it failed.
- **`expect.row` at its deadline.** No row uploaded, and the message names `review / review`'s jobs and their conclusions: a `failure` there is an agent that failed without uploading its row (Kanon's `agent-finish` didn't run); all `success`, Kanon renamed the artifact or the lane.
- **`expect.row` on the row.** Its cost was past $30, which is still recorded. `infra` with `unavailable`: the model was never reached, so it is retried, not failed.
- **`expect.run` on `review / review` `failure`.** The agent failed after uploading its row, so its cost is recorded. Its run's summary says why. A missing `CLAUDE_CODE_OAUTH_TOKEN` reads `infra` before this, at the `act` job's precondition.
- **`expect.pr` on the marker.** The Reviewer posted nothing with its role marker, or posted as another App.
