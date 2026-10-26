# A dead chat webhook turns notify red and leaves the digest green

Kanon's plan 0011 step N12, the revoked-webhook check (yedeya-labs/kanon#1081), moved to the harness by the Owner's decision of 2026-10-22: a regression test in the gate rather than a one-off manual revoke (harness #123). It installs Kanon's review lane and daily project digest with Kanon's Slack hook, at the release under test, and stores a Slack webhook URL that no workspace holds as the repository's `KANON_CHAT_PROJECT_DIGEST`. The test Author dispatches the digest. The scenario holds Kanon's notify path to its contract when a chat webhook is dead (`K-SHIP-10`): the `notify` job fails, the `digest` job that produced the message stays green, and `kanon doctor` reports `notify.failing`, a note that blocks nothing. Nobody touches Slack.

`scenario.json`: family `lane`, tier `model`, Claude `subscription`, `author` and `judge` as its test Apps, a deadline of 120 minutes, and `gate: false`: it is new, so its result changes nothing on a candidate's run until it has passed ten runs in a row (Kanon plan 0012 §10, decision 24), and it joins the gate only once the ledger's measured cost fits (§9). It is `claude: subscription` because the digest job runs the model, its narrative, before `notify` posts. Its `runsOn` is `["candidate", "dispatch"]`: it takes part in a candidate's run and a dispatch, never the nightly (the Owner, 2026-10-25). Its `chatPlaceholder` has `provision` store the dead webhook, and its `authorDispatch` names the digest's caller, `agent-project-digest.yml`.

## The dead webhook

`provision` stores a fixed placeholder, `https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX`, as `KANON_CHAT_PROJECT_DIGEST`, in its step "Write the dead chat webhook", which runs only for a scenario whose `scenario.json` sets `chatPlaceholder` (the Owner, 2026-10-25). `provision` already holds Secrets write on the new repository for the Apps' secrets, so no verb writes it and the `act` job's token is not widened. The URL is well-formed: Kanon's Slack hook takes any `https://hooks.slack.com/services/…` URL, so it doesn't refuse it by shape. No workspace holds it, so Slack refuses the post as it refuses a revoked webhook, with a 4xx, and the hook fails. It is no secret: it is written in `e2e.yml`, not kept in the `e2e` environment.

## Who dispatches the digest

The project digest's gate admits a dispatch only by a member or a registered agent App (Kanon's `scripts/lane-gate.mjs`, `K-AGENT-45`). The driver App, which makes every other event here, is neither ([`refuse-review-label`](../refuse-review-label/README.md) holds that refusal for a label). A dispatch by the driver would be refused at the gate, every job would skip, and the run would be green with nothing posted. So after phase 1, `e2e.yml`'s `author-dispatch` job, a pair of its own, mints the test Author's token for this one repository (Actions write) and dispatches `agent-project-digest.yml` on the default branch with `gh`, as an adopter's member runs it by hand. The Author is in the App register (`register.write`), so the gate admits it. That job runs no harness code and no Kanon code (`K-AGENT-50`) ([`docs/jobs.md`](../../docs/jobs.md)). The Owner chose this on 2026-10-25, over registering the driver here, which would break `refuse-review-label`'s premise, and over a merge queue's schedule, which is fragile and slow (#66).

## What the repository holds

`start/` is one file, a `README.md` that names the scenario, the release and the repository (`{{release}}` and `{{repository}}` filled in). `provision` writes `KANON_CHAT_PROJECT_DIGEST`, the dead webhook, and `model-key` writes `CLAUDE_CODE_OAUTH_TOKEN` before the first phase, once the real-model ledger admitted the scenario.

## The flags

`kanon.init` always runs `kanon init --json --yes --no-apps --consent no`: no Apps created, telemetry and sharing declined (decision 8). The scenario adds:

- `--lanes=review,project-digest`: the review lane, so phase 1 is `install-review`'s install, and the daily project digest, the lane that posts;
- `--review-trigger=labelled` and `--no-sensitive-data`, as `install-review` has them;
- `--chat=slack`: `init` writes Kanon's Slack hook at `.github/actions/notify/action.yml`, so the digest's gate finds a hook and posts;
- `--claude-auth=subscription`: the callers map `CLAUDE_CODE_OAUTH_TOKEN`, the secret `model-key` writes.

## The steps

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon`, `act` | `install-review`'s phase 1, with this scenario's flags | What `install-review` expects, and the `init` document's `/answers/chat` is `slack`. |
| — | `author-dispatch` | **The dispatch:** the test Author dispatches `agent-project-digest.yml` on `main` | |
| 2 | `act` | `run.await` for `agent-project-digest.yml`'s `workflow_dispatch` run on `main`, with `actor: author` | The run the Author's dispatch started completes, within 23 minutes: with the 7 of the two expectations after it, phase 2's waits fit the `act` job's 30-minute timeout, so a slow digest reads `fail`, not `missing` (#145). |
| 2 | `act` | `expect.row` | The run's `kanon-telemetry-project-digest-<run>-<attempt>` row is a version-2 `project-digest` row whose `total_cost_usd` is at most $10, the lane's `--max-budget-usd`. Its cost is kept as the result's `costUsd`, the ledger's history. `outcome: unavailable` reads `infra`. With no row, it reads `digest / digest` (its `job`): `skipped` fails at once, naming `digest / gate` beside it. |
| 2 | `act` | `expect.run` | The run concluded `failure`, with `digest / gate` and `digest / digest` `success` and `digest / notify` `failure`: the post failed, and the job that produced the message stayed green. |
| 3 | `kanon` | `kanon.doctor`, then `expect.doctor` | The document holds `notify.failing`, and no finding blocks (`blocking: []`), so `notify.failing` is a note. `secrets` and `notify-secrets` may read `unchecked` on the `kanon` job's read-only token; any other `unchecked` check fails it. |

**Why the row comes first** (harness #105, as in [`review-real`](../review-real/README.md#the-steps)). A step that fails ends the scenario. The row is read before the run's conclusion, so its cost is recorded whatever the run did: the ledger reads only recorded costs, and the scenario runs on a candidate only once it has one.

**What isn't asserted: the collector's `notify` row** (the Owner, 2026-10-25). The issue asked for the telemetry collector's `notify` row to read `failed` where the repository runs the collector. `expect.row` reads only a model lane's run row, the artifact the lane uploads whether or not the repository sends telemetry; the `notify` job's delivery row is another artifact, which only a repository registered with the collector sends on. A throwaway scenario repository isn't registered with the collector, so the scenario doesn't assert it. The `expect.row` above is the digest's own cost row, for the ledger, not the delivery row.

## What it creates

One public repository in `kanon-e2e`, `e2e-notify-revoked-<run>-<attempt>`, holding what `install-review`'s holds, plus:

- the daily project digest's caller, `agent-project-digest.yml`, and Kanon's Slack hook at `.github/actions/notify/action.yml`;
- the secrets `KANON_CHAT_PROJECT_DIGEST`, the dead webhook, and `CLAUDE_CODE_OAUTH_TOKEN`;
- the digest's dispatched run on `main`, red on its `notify` job, and any issue its `health` job files.

The repository is deleted when the scenario passes, with its secrets. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Model:** one digest narrative on a repository with no projects. Its cost is unmeasured until the first run; the lane's ceiling is $10. The ledger starts it only on the Owner's dispatch, alone, until it has a recorded cost, and afterwards only when its expected cost, the largest of its last ten recorded costs times 1.5, fits the run's $2 ([`docs/jobs.md`](../../docs/jobs.md#the-real-model-ledger)). On the subscription token that cost is Claude Code's reckoning, not a bill; it comes out of the subscription's usage limits.
- **Time:** about 30 to 40 minutes, an estimate until the first dispatch measures it. The deadline is 120 minutes.
- **Minutes:** the repositories are public, so their runs cost nothing (probe 6).
- **People:** none, once it has a cost. **The first run is the Owner's dispatch, with this scenario selected alone:** it is a subscription scenario with no cost history, so until a run records one, a candidate's run sets it aside and only a dispatch selecting it starts it. **Before that first dispatch, the Author App's registration must grant Actions write** (read and write, in the App's permissions, accepted on its `kanon-e2e` installation): `author-dispatch`'s mint asks for it, and until now the Author was asked only for Issues and Pull requests write. Without it the mint fails, and `run.await` passes its deadline.

Dispatch it, alone:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=notify-revoked
```

## When it is red

The failing job's summary names the first failure. A failure in phase 1 is an install failure: read [`install-review`'s list](../install-review/README.md#when-it-is-red). After it, what it usually means:

- **`run.await` passed its deadline.** No run the Author started reached `main`: check the `author-dispatch` job (the mint failed, on the Author App's installation or key, or the dispatch was refused, as for a workflow file `init` didn't write under that name). Or the digest took longer than 23 minutes: the digest job's own timeout is 20, and the first dispatches measure how long the whole run takes. The deadline can't grow while the row and the run are checked in the same phase: phase 2's waits must fit an `act` job's 30 minutes, and the row must stay before doctor, in phase 3's `kanon` segment. Its message names who started the runs it saw.
- **`expect.row` fails at once: `digest / digest` was skipped.** No row was uploaded, so this is the first failure. Read the skip by `digest / gate`, which the message names beside it: `success` there means the gate refused the dispatch (the Author isn't on a role's row of the register, or Kanon changed who may dispatch), or found no hook or no `KANON_CHAT_PROJECT_DIGEST` (its summary says which: `provision` didn't write the placeholder, or `init` wrote no hook); `failure` means the gate itself failed, and its log says why.
- **`expect.row` at its deadline, or on the row.** As for [`review-real`](../review-real/README.md#when-it-is-red): no row uploaded, or a cost past $10, which is still recorded; `infra` with `unavailable`, the model was never reached.
- **`expect.run` on `digest / notify` `success`.** The post didn't fail. Either Slack accepted the placeholder, which it shouldn't, or the `notify` block recorded the post as `skipped` (no secret or no message), which is green: its summary names the outcome. A Kanon whose `notify` job turns a refused post green breaks `K-SHIP-10`'s "a failed post is reported as a failed post".
- **`expect.run` on `digest / digest` `failure`.** The producer failed, so the scenario can't tell a failed post from a missing message. The job's log says why: the narrative step is non-fatal, so it is the message script or its upload.
- **`expect.doctor` without `notify.failing`.** Doctor didn't read the failed `notify` job: the check `notify-runs` would read `unchecked` if the token couldn't read the run or its log, which fails the `unchecked` list first. Otherwise Kanon changed the `kanon-notify/v1` line or the finding's id.
- **`expect.doctor` on a blocking finding.** Either `notify.failing` now blocks, against the Owner's decision of 2026-10-25, or the install left something else that blocks: the message names it.
