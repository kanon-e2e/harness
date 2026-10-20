# The jobs, the secrets and the sizing

What `e2e.yml` and the weekly upgrade signal (`upgrade-signal.yml`) run, which job holds which secret, how big a run may be, and what Kanon's release gate reads of a run ([Kanon plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) §5.2, §5.3, §8.2; harness #16, #40). `tests/e2e-workflows.test.mjs` and `tests/workflows.test.mjs` hold the workflows to this page, `tests/sizing.test.mjs` the numbers, `tests/verdict-report.test.mjs` the verdict, its issues and the check run, and `tests/upgrade-signal.test.mjs` the upgrade signal's workflow.

## The jobs

| Job | Environment | Holds | Does |
|---|---|---|---|
| `plan` | none | the workflow's own token, read-only (`actions`, `contents`) | Decides whether the run goes ahead, and with which release and scenarios (`runner/plan.mjs`). Records the run's marker artifact. Creates nothing. |
| `start` | `e2e-report` | the Reporter's key | A candidate's run only: creates the `kanon-e2e` check run on the candidate's commit, `in_progress`, with `external_id` `<run id>-<run attempt>` and `details_url` the run's page. Its name records the candidate: `start (the Reporter's check run: <tag> at <40-hex sha>)`. |
| `provision` | `e2e` | the driver's key; the test Apps' ids and keys | For each scenario: creates the public repository `e2e-<scenario>-<run>-<attempt>`, empty, with the `kanon-e2e` topic; writes the Apps the scenario lists as `<APP>_APP_ID` and `<APP>_APP_PRIVATE_KEY`; sets the merge settings the release under test's merge-settings guard checks (`K-ADOPT-1` step 5), read from its `release.yml`, before anything reaches the default branch; adds `kanon-e2e-provisioned`. |
| `model-key` | `e2e` (`mint`), `e2e-model` (the job) | the driver's key (`mint`); the real-model token (the job) | For each `claude: subscription` scenario: writes `CLAUDE_CODE_OAUTH_TOKEN` into its repository. |
| `kanon-1` … `kanon-3` | `e2e` (`mint`) | the driver's key (`mint`); a read-only token (the job) | Phase *n*'s `kanon` segment: Kanon's code at the release under test, in a clone. |
| `act-1` … `act-3` | `e2e` (`mint`) | the driver's key (`mint`); the act token (the job) | Phase *n*'s `act` segment: the harness's code, pushing what Kanon wrote and doing the rest. The job that learns the result ends the repository. |
| `gate-2`, `gate-3` | none | the workflow's own token, `contents: read`; no key | Before phase *n*'s `kanon` job: decides the scenarios phase *n* runs (`runner/gate.mjs`, #62). It drops a scenario with fewer than *n* phases, and one whose `kanon-e2e-result-<scenario>` names this attempt's repository, because an earlier phase ended it and its repository was deleted or archived. Phase *n*'s `kanon` and `act` jobs take their matrix from it, and are skipped when it keeps none, so no mint is scoped to a repository that may be gone. It never fails for what it drops. |
| `verdict` | none | the workflow's own token, `contents: read` and `issues: write` on this repository; no key | Reads each scenario's `kanon-e2e-result/v1` and writes `verdict.json` (`kanon-e2e-verdict/v1`), and hands `report` the verdict and the red issue as its job outputs: `pass`, `fail` or `infra-only`, over the scenarios with `gate: true` on a candidate's run and over every planned scenario elsewhere (`runner/verdict.mjs`). On a candidate's run only, files, edits or closes the candidate's red issue and the `the Reporter can't post` issue. Red unless `pass`. |
| `report` | `e2e-report` | the Reporter's key | Whenever `start` created a check run: completes it from `verdict`'s job outputs, never from an artifact, `success` for `pass`, `failure` for `fail`, `neutral` for anything else, retrying a failed call twice. Its summary links this run and, when there is one, the candidate's red issue. |

**The pairs.** Every job that runs code beside a token minted from the driver's key is a pair, the spine Kanon's own lanes use (Kanon's `overseer-run.yml`, `K-AGENT-49`). A `-run` workflow holds a `mint` job, in `e2e`, that holds the key and runs only the token action. It mints with `skip-token-revoke` and hands the token on hex-encoded. Its `-job` workflow is one job, handed only the token as a secret: `Receive the App token` comes first, refusing a token minted for an earlier attempt, and `Revoke the App token` comes last, always. A called workflow sees an environment's secret only when it declares it under `on.workflow_call.secrets` and its caller maps it by name (Kanon #1049, item 12), so each `-run` declares the driver's id and key, and `e2e.yml` maps them.

| Pair | The `mint`'s token |
|---|---|
| `e2e-kanon-run.yml` → `e2e-kanon-job.yml` | the one scenario repository; Contents, Issues, Pull requests, Actions, Administration **read**; no Workflows, no Secrets |
| `e2e-act-run.yml` → `e2e-act-job.yml` | the one scenario repository; Contents, Workflows, Issues, Pull requests, Actions, Administration write; Secrets, Checks read |
| `e2e-model-key-run.yml` → `e2e-model-key-job.yml` | the one scenario repository; Secrets write |
| `e2e-janitor-run.yml` → `e2e-janitor-job.yml` | the whole test organisation; Administration write |

## The kanon/act split (decision 23 (b))

**Kanon's code never holds a write token.** The `kanon` job runs Kanon's code at the release under test, `npx --package github:yedeya-labs/kanon#<release> kanon …`, as an adopter fetches it. It clones the public scenario repository with no token, lays `start/` in the clone on the first phase, and runs `kanon init` and `kanon doctor` there. Its token is read-only, for what Kanon reads. What Kanon writes lands only in its clone. `init`'s settings, labels, milestones and ruleset are left to a person (`steps-left`), and `repo.apply` applies them in the `act` job with the harness's own code.

**The `act` job runs no Kanon code.** It pushes the files Kanon wrote, applies `init`'s settings, opens and merges pull requests, and waits on runs, with the harness's code alone. `tests/vocabulary.test.mjs` holds the verbs that run Kanon's code to the `kanon` segment.

**The `kanon` job's tree crosses as data.** The `kanon` job uploads its clone without `.git/`. The `act` job downloads it into a scratch directory and runs nothing there: no git, so no hook and no `core.fsmonitor` the tree might carry. `runner/lib/artifact.mjs` walks it with `lstat` and takes only regular files. It opens each without following a link, and holds each to one link. A `.git` anywhere, a symlink, a hard link, a FIFO or a device refuses the whole artifact, and the scenario reads `fail`. The `act` job then clones the repository itself, with the act token passed to git through the environment and never written to disk, and writes those bytes into its own clone. `tests/artifact.test.mjs` runs a hostile tree through it: a pre-push hook, a `core.fsmonitor`, and a symlink to a secret.

**The state crosses as JSON** (`kanon-e2e-state/v1`): what the steps kept, the result once set, and the first failure. A state that arrives claiming `pass` before an `act` job finalized the scenario is refused, as `infra`. So is a state that is missing, or is for another scenario or repository.

**What a `kanon` job's code can upload (harness #24).** Kanon's code runs in the same job as that job's later `upload-artifact` steps, whose files it can probably rewrite. Then it can upload an artifact under any name in the run, for its own scenario or another's. Nobody has measured that on a hosted runner yet, so this page assumes it.

- **Closed: the verdict.** `report` reads the verdict and the red issue from the `verdict` job's outputs, which no other job can set. `verdict` uploads `verdict.json`, for people to read, with `overwrite`, so one planted under its name is replaced rather than blocking the upload.
- **Open: the results, and through them the gate.** A `kanon` job runs after the `act` jobs of every earlier phase, so it can plant `kanon-e2e-result-<scenario>` for any scenario, reading `pass` and naming this attempt's repository, `e2e-<id>-<run id>-<attempt>`, which the job knows. Three readers take it as real: `verdict`, which reads it as the scenario's result; `gate-2` and `gate-3` (`runner/gate.mjs`), which take it to mean the scenario ended, and drop its later phases, so no later `act` job runs to replace it; and `runner/burn-in.mjs`, which counts a past run's result toward `gate: true`. So a scenario still running, the gating `deploy-rehearsal` among them, can read `pass` without its later phases running at all. No state is needed. **The states:** since #63, a scenario that ended in any way is dropped from the later phases, and one with fewer phases than *n* never reaches phase *n*, so a planted state no longer turns a kept `fail` into `pass`. A state planted for a scenario still running can still change what its next `act` job reads as kept, the `init` and `doctor` documents among them, but those come from a `kanon` job, where Kanon's code runs anyway. That is the residual #24 already names. No write token is reached, so decision 23 (b) still holds. What's lost is the gate's integrity against the code it judges, until #24's R2 and R3 land.

## Pass, fail, infra

| Result | When | The repository |
|---|---|---|
| `pass` | The last phase's `act` segment ran every step. | Deleted. |
| `fail` | An expectation was false, a step's or the scenario's deadline passed, the artifact was refused, or the harness's own code went wrong. | Kept 24 hours, topic `kanon-e2e-failed`, then archived (decision 13). |
| `infra` | GitHub failed past the retries, a token expired, the repository wasn't provisioned or is gone, or the state didn't arrive. | Deleted. |
| `skipped` | The runner refused to start the scenario, and says why in the result's `skipped` field, a short word: `budget` when the real-model ledger (E10) found it could pass the run's $2. Nothing writes it yet. `verdict` reads a counted `skipped` as `fail`, and a `skipped` with no such word as missing. | — |

A call to GitHub, by `gh` or by `git`'s clone, fetch, push and ls-remote, that fails on a 5xx, a rate limit or a network error is retried three times, after 2, 4 and 8 seconds, or a minute on a rate limit. A false expectation is never retried: it is the finding. The result is set once, and a later phase can't change it. The `act` job that learns the result ends the repository and uploads `kanon-e2e-result-<scenario>`. The janitor deletes what a dead run left.

## The sizing

`runner/settings.json` holds the settings. `runner/sizing.mjs` derives the rest. `node runner/sizing.mjs` prints it.

| Value | Now | From |
|---|---|---|
| Jobs at once | 6 | E0's item 5 (Kanon #968): the organisation ran 7 steady, 8 at most, against GitHub's documented 20. 6 is the measured range's lower end. |
| Jobs kept for the harness's own lanes and the janitor | 1 | |
| Jobs one scenario holds at once | 2 | its phase's job, and the run it waits on in its own repository |
| **max-parallel** | **2** | ⌊(6 − 1) / 2⌋, on every matrix in `e2e.yml` |
| Repositories an hour | 80 | E0's item 4: 80 created in five minutes, so a lower bound |
| Nightly interval | 24 h | |

**One run at a time** (the Owner, 2026-10-17). So a run is sized against the organisation's limits alone, not shared with a second run. A job that `needs:` a matrix waits for all its entries. With 2 at once, each stage runs in waves of 2. A repository lives from its `provision` to the last wave of `act-3`. With *W* = ⌈*n* / 2⌉ waves and at most two real-model scenarios, its longest running time is

*W* × 10 (provision) + ⌈min(*n*, 2) / 2⌉ × 10 (model key) + 3 × *W* × (25 + 35) (each phase's `kanon` and `act` pairs, mint included) + 2 × 5 (`gate-2` and `gate-3`, one job each, not in waves).

The **catalogue's cap** is the largest *n* whose longest running time fits the nightly interval and whose 2*n* repositories (each scenario, and its re-run) fit the hour's 80. That is **14 scenarios**. 14 scenarios take **22 h 30 min**, so a run ends inside the 24 hours before the next nightly. `plan` refuses a catalogue past the cap.

**The janitor's cut-offs** follow: the longest running time at the cap, plus 100 minutes' margin for queueing, is **24 h 10 min**. A repository with `kanon-e2e-failed` gets 24 hours more, **48 h 10 min**. It runs hourly (`e2e-janitor.yml`). It deletes only repositories with the `kanon-e2e` topic, never the harness. Its run fails, by name, on a repository older than a day that it couldn't delete.

Change a setting and the tests name each place that must follow: the max-parallel on each matrix, each job's `timeout-minutes`, and the cut-offs.

## What Kanon's gate reads

Kanon's release gate (plan 0012 §8.2, Kanon's step E11) reads five facts for a candidate, on its commit in `yedeya-labs/kanon`, and needs every one. Both repositories are public, so none of these calls needs a credential.

| # | The fact | The call | Credential |
|---|---|---|---|
| 1 | A check run named `kanon-e2e`, made by the Reporter, `kanon-e2e-reporter`, App id `5349415` (read from check run `117645071658` on `candidate-v0.41.0`'s commit `adb944e6`). One of that name from any other App is ignored. | `GET repos/yedeya-labs/kanon/commits/<sha>/check-runs?check_name=kanon-e2e&app_id=5349415` | none |
| 2 | The latest such check run concluded `success`. | the same call: its `status` and `conclusion` | none |
| 3 | The harness run it links, through its `external_id`, `<run id>-<run attempt>` (for example `39117109753-1`), is a run of `.github/workflows/e2e.yml` on this repository's `main`. | `GET repos/kanon-e2e/harness/actions/runs/<run id>`: its `path` and `head_branch` | none |
| 4 | That attempt's **`verdict` job** concluded `success`, which it does only when the verdict was `pass`. The run's own conclusion is not read. | `GET repos/kanon-e2e/harness/actions/runs/<run id>/attempts/<attempt>/jobs`: the job named `verdict` | none |
| 5 | The release tag and the commit that run recorded are the candidate's. | the same jobs list: the job named `start (the Reporter's check run: <tag> at <40-hex sha>)` | none |

**Why the name of `start` records them.** `plan`'s artifact `e2e-candidate-<tag>` holds `marker.json`, with `release` and `candidateSha`, and its name is public. Its contents are not: on 2026-10-18, `GET repos/kanon-e2e/harness/actions/artifacts/<id>/zip` with no token answered `401 Requires authentication`. The jobs list is public, and fact 4 reads it anyway. Job names come from `e2e.yml` on `main`, so no code under test can change them.

**Which attempt.** The `external_id` names the attempt, so the gate reads that attempt's jobs, and a re-run's check run is read against its own `verdict` job.

**What holds the gate red** (`runner/verdict.mjs`):

- On a candidate's run, only the scenarios with `gate: true` count, read from the catalogue at the run's commit as `plan`'s `scenarios` output carries it, never from a result. A `gate: false` scenario is listed in `verdict`'s summary with its result, and changes nothing.
- A counted scenario that read `fail`, or `skipped` (such as `skipped: budget`), gives `fail`. One that read `infra`, or left no result, gives `infra-only`, unless another counted scenario failed.
- A candidate's run with no `gate: true` scenario gives `fail`, "no scenario gates yet", never `pass`.
- While the candidate's red issue is open and holds a `fail`, every run of that candidate gives `fail`, whatever its scenarios did.

## The upgrade signal's jobs

`.github/workflows/upgrade-signal.yml` runs weekly and on dispatch, outside `e2e.yml` (plan 0012 step E14; [the README](../README.md#the-upgrade-signal)). It splits as a scenario's phase does: Kanon's code in one job, the harness's in another, and only the second writes. Its only credential is the workflow's token. `tests/upgrade-signal.test.mjs` holds it to this table.

| Job | Environment | Holds | Does |
|---|---|---|---|
| `doctor` | none | the workflow's own token: `actions`, `checks`, `contents`, `issues` read | Checks out `main`, with its history, and runs `kanon doctor --json` there with `npx`, at the one release the harness's workflows pin. Keeps the document as the `upgrade-signal-doctor` artifact. Writes nothing to GitHub. |
| `signal` | none | the workflow's own token: `actions` and `contents` read, `issues: write` | Runs `runner/upgrade-signal.mjs`, the harness's code alone: reads doctor's document as data, Kanon's releases and the latest completed `release.yml` run on `main`, then opens, edits or closes the one `long-lived upgrade behind` issue. |

**What `doctor`'s code can reach.** The release the harness pins runs with read permissions, so the worst it can do is plant a document that reads healthy, which only keeps the issue closed. That is the same release every lane of the harness already runs.
