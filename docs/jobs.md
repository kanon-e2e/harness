# The jobs, the secrets and the sizing

What `e2e.yml` runs, which job holds which secret, and how big a run may be ([Kanon plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) §5.2, §5.3; harness #16). `tests/e2e-workflows.test.mjs` and `tests/workflows.test.mjs` hold the workflows to this page, and `tests/sizing.test.mjs` the numbers.

## The jobs

| Job | Environment | Holds | Does |
|---|---|---|---|
| `plan` | none | the workflow's own token, read-only (`actions`, `contents`) | Decides whether the run goes ahead, and with which release and scenarios (`runner/plan.mjs`). Records the run's marker artifact. Creates nothing. |
| `start` | `e2e-report` | the Reporter's key | A candidate's run only: creates the `kanon-e2e` check run on the candidate's commit, `in_progress`. |
| `provision` | `e2e` | the driver's key; the test Apps' ids and keys | For each scenario: creates the public repository `e2e-<scenario>-<run>-<attempt>`, empty, with the `kanon-e2e` topic; writes the Apps the scenario lists as `<APP>_APP_ID` and `<APP>_APP_PRIVATE_KEY`; adds `kanon-e2e-provisioned`. |
| `model-key` | `e2e` (`mint`), `e2e-model` (the job) | the driver's key (`mint`); the real-model token (the job) | For each `claude: subscription` scenario: writes `CLAUDE_CODE_OAUTH_TOKEN` into its repository. |
| `kanon-1` … `kanon-3` | `e2e` (`mint`) | the driver's key (`mint`); a read-only token (the job) | Phase *n*'s `kanon` segment: Kanon's code at the release under test, in a clone. |
| `act-1` … `act-3` | `e2e` (`mint`) | the driver's key (`mint`); the act token (the job) | Phase *n*'s `act` segment: the harness's code, pushing what Kanon wrote and doing the rest. The job that learns the result ends the repository. |
| `verdict` | none | the workflow's own token, `contents: read` | Reads each scenario's `kanon-e2e-result/v1` and writes `verdict.json`: `pass`, `fail` or `infra-only`. Red unless `pass`. |
| `report` | `e2e-report` | the Reporter's key | Whenever `start` created a check run: completes it, `success` for `pass`, `failure` for `fail`, `neutral` for anything else. |

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

## Pass, fail, infra

| Result | When | The repository |
|---|---|---|
| `pass` | The last phase's `act` segment ran every step. | Deleted. |
| `fail` | An expectation was false, a step's or the scenario's deadline passed, the artifact was refused, or the harness's own code went wrong. | Kept 24 hours, topic `kanon-e2e-failed`, then archived (decision 13). |
| `infra` | GitHub failed past the retries, a token expired, the repository wasn't provisioned or is gone, or the state didn't arrive. | Deleted. |

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

*W* × 10 (provision) + ⌈min(*n*, 2) / 2⌉ × 10 (model key) + 3 × *W* × (25 + 35) (each phase's `kanon` and `act` pairs, mint included).

The **catalogue's cap** is the largest *n* whose longest running time fits the nightly interval and whose 2*n* repositories (each scenario, and its re-run) fit the hour's 80. That is **14 scenarios**. 14 scenarios take **22 h 20 min**, so a run ends inside the 24 hours before the next nightly. `plan` refuses a catalogue past the cap.

**The janitor's cut-offs** follow: the longest running time at the cap, plus 100 minutes' margin for queueing, is **24 h**. A repository with `kanon-e2e-failed` gets 24 hours more, **48 h**. It runs hourly (`e2e-janitor.yml`). It deletes only repositories with the `kanon-e2e` topic, never the harness. Its run fails, by name, on a repository older than a day that it couldn't delete.

Change a setting and the tests name each place that must follow: the max-parallel on each matrix, each job's `timeout-minutes`, and the cut-offs.
