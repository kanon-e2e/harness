# The jobs, the secrets and the sizing

What `e2e.yml` and the weekly upgrade signal (`upgrade-signal.yml`) run, which job holds which secret, how big a run may be, and what Kanon's release gate reads of a run ([Kanon plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) §5.2, §5.3, §8.2; harness #16, #40). `tests/e2e-workflows.test.mjs` and `tests/workflows.test.mjs` hold the workflows to this page, `tests/sizing.test.mjs` the numbers, `tests/verdict-report.test.mjs` the verdict, its issues and the check run, `tests/evidence.test.mjs` the result steps the verdict reads, and `tests/upgrade-signal.test.mjs` the upgrade signal's workflow.

## The jobs

| Job | Environment | Holds | Does |
|---|---|---|---|
| `plan` | none | the workflow's own token, read-only (`actions`, `contents`) | Decides whether the run goes ahead, and with which release and scenarios (`runner/plan.mjs`). Asks the real-model ledger which `claude: subscription` scenarios may start ([below](#the-real-model-ledger)), and outputs as `skipped` those it refused for their cost, and the gating ones it refused for any reason. Records the run's marker artifact. Creates nothing. |
| `start` | `e2e-report` | the Reporter's key | A candidate's run only: creates the `kanon-e2e` check run on the candidate's commit, `in_progress`, with `external_id` `<run id>-<run attempt>` and `details_url` the run's page. Its name records the candidate: `start (the Reporter's check run: <tag> at <40-hex sha>)`. |
| `provision` | `e2e` | the driver's key; the test Apps' ids and keys | For each scenario: creates the public repository `e2e-<scenario>-<run>-<attempt>`, empty, with the `kanon-e2e` topic; writes the Apps the scenario lists as `<APP>_APP_ID` and `<APP>_APP_PRIVATE_KEY`; sets the merge settings the release under test's merge-settings guard checks (`K-ADOPT-1` step 5), read from its `release.yml`, before anything reaches the default branch; adds `kanon-e2e-provisioned`. |
| `model-key` | `e2e` (`mint`), `e2e-model` (the job) | the driver's key (`mint`); the real-model token (the job) | For each `claude: subscription` scenario the ledger admitted, `plan`'s `model-scenarios`: writes `CLAUDE_CODE_OAUTH_TOKEN` into its repository. A refused scenario has no repository and gets no token. |
| `author-label` | `e2e` (`mint`) | the Author's key (`mint`); the Author's label token (the job) | After `act-1`, for each planned scenario whose `scenario.json` names an `authorLabel` (`plan`'s `author-labels`): applies the label to the open pull request from its branch, with `gh` alone, as the test Author. A model lane's gate admits the Author, a member of the scenario's App register, and never the driver (K-AGENT-45). It labels nothing, and says so, when the repository is archived or no such pull request is open. `gate-2` waits for it. |
| `kanon-1` … `kanon-3` | `e2e` (`mint`) | the driver's key (`mint`); a read-only token (the job) | Phase *n*'s `kanon` segment: Kanon's code at the release under test, in a clone. |
| `act-1` … `act-3` | `e2e` (`mint`) | the driver's key (`mint`); the act token (the job) | Phase *n*'s `act` segment: the harness's code, pushing what Kanon wrote and doing the rest. The job that learns the result records it as the repository's topic, ends the repository, and runs the one step named for it, `The scenario reads <result>` (#24, [below](#the-kanonact-split-decision-23-b)). |
| `gate-2`, `gate-3` | none | the workflow's own token, `contents: read`; no key | Before phase *n*'s `kanon` job: decides the scenarios phase *n* runs (`runner/gate.mjs`, #62). It drops a scenario with fewer than *n* phases, and one an earlier phase ended: its repository for this attempt, `e2e-<id>-<run id>-<attempt>`, is gone, archived, or carries a result topic. It reads each repository, public, with its own token, and never a `kanon-e2e-result-<scenario>` artifact (#24). It keeps a scenario whose repository it couldn't read, with a warning: that scenario's own `act` job reads the repository again. Phase *n*'s `kanon` and `act` jobs take their matrix from it, and are skipped when it keeps none, so no mint is scoped to a repository that may be gone. It never fails for what it drops. |
| `verdict` | none | the workflow's own token, `actions: read`, `contents: read` and `issues: write` on this repository; no key | Reads each scenario's result from the run's jobs list, and its `kanon-e2e-result/v1` for the details (#24, [below](#the-kanonact-split-decision-23-b)), and `plan`'s `skipped` as those scenarios' results, and writes `verdict.json` (`kanon-e2e-verdict/v1`), and hands `report` the verdict and the red issue as its job outputs: `pass`, `fail` or `infra-only`, over the scenarios with `gate: true` on a candidate's run and over every planned scenario elsewhere (`runner/verdict.mjs`). On a candidate's run only, files, edits or closes the candidate's red issue and the `the Reporter can't post` issue. Red unless `pass`. |
| `report` | `e2e-report` | the Reporter's key | Whenever `start` created a check run: completes it from `verdict`'s job outputs, never from an artifact, `success` for `pass`, `failure` for `fail`, `neutral` for anything else, retrying a failed call twice. Its summary links this run and, when there is one, the candidate's red issue. |

**The pairs.** Every job that runs code beside a token minted from the driver's key is a pair, the spine Kanon's own lanes use (Kanon's `overseer-run.yml`, `K-AGENT-49`). A `-run` workflow holds a `mint` job, in `e2e`, that holds the key and runs only the token action. It mints with `skip-token-revoke` and hands the token on hex-encoded. Its `-job` workflow is one job, handed only the token as a secret: `Receive the App token` comes first, refusing a token minted for an earlier attempt, and `Revoke the App token` comes last, always. A called workflow sees an environment's secret only when it declares it under `on.workflow_call.secrets` and its caller maps it by name (Kanon #1049, item 12), so each `-run` declares the driver's id and key, and `e2e.yml` maps them.

| Pair | The `mint`'s token |
|---|---|
| `e2e-kanon-run.yml` → `e2e-kanon-job.yml` | the one scenario repository; Contents, Issues, Pull requests, Actions, Administration **read**; no Workflows, no Secrets |
| `e2e-act-run.yml` → `e2e-act-job.yml` | the one scenario repository; Contents, Workflows, Issues, Pull requests, Actions, Administration write; Secrets, Checks read |
| `e2e-model-key-run.yml` → `e2e-model-key-job.yml` | the one scenario repository; Secrets write |
| `e2e-author-label-run.yml` → `e2e-author-label-job.yml` | minted from the **Author's** key, not the driver's: the one scenario repository; Issues and Pull requests write. The job is three steps, receive, `gh` applies the label, revoke, with no checkout, no harness code and no Kanon code (K-AGENT-50) |
| `e2e-janitor-run.yml` → `e2e-janitor-job.yml` | the whole test organisation; Administration write |

**A change to plan 0012 §5.2 and §11** (the Owner, 2026-10-20, for E10). The plan has the test Apps' keys read only by `provision`, which writes them as each scenario repository's secrets. Now `e2e-author-label-run.yml`'s `mint` reads the Author's key too, in `e2e`, to mint a token for one repository with Issues and Pull requests write. A leak of that token can label, comment on and edit issues and pull requests in one throwaway repository for its hour, as the Author, which that repository's lanes admit as their Implementer: it can start a model lane there, on the subscription token the repository holds. It can push nothing and change no workflow or secret. The job that holds it runs only `gh`, on inputs from `plan`, which reads the catalogue at `main`.

## The kanon/act split (decision 23 (b))

**Kanon's code never holds a write token.** The `kanon` job runs Kanon's code at the release under test, `npx --package github:yedeya-labs/kanon#<release> kanon …`, as an adopter fetches it. It clones the public scenario repository with no token, lays `start/` in the clone on the first phase, and runs `kanon init` and `kanon doctor` there. Its token is read-only, for what Kanon reads. What Kanon writes lands only in its clone. `init`'s settings, labels, milestones and ruleset are left to a person (`steps-left`), and `repo.apply` applies them in the `act` job with the harness's own code.

**The `act` job runs no Kanon code.** It pushes the files Kanon wrote, applies `init`'s settings, opens and merges pull requests, and waits on runs, with the harness's code alone. `tests/vocabulary.test.mjs` holds the verbs that run Kanon's code to the `kanon` segment.

**The `kanon` job's tree crosses as data.** The `kanon` job uploads its clone without `.git/`. The `act` job downloads it into a scratch directory and runs nothing there: no git, so no hook and no `core.fsmonitor` the tree might carry. `runner/lib/artifact.mjs` walks it with `lstat` and takes only regular files. It opens each without following a link, and holds each to one link. A `.git` anywhere, a symlink, a hard link, a FIFO or a device refuses the whole artifact, and the scenario reads `fail`. The `act` job then clones the repository itself, with the act token passed to git through the environment and never written to disk, and writes those bytes into its own clone. `tests/artifact.test.mjs` runs a hostile tree through it: a pre-push hook, a `core.fsmonitor`, and a symlink to a secret.

**The state crosses as JSON** (`kanon-e2e-state/v1`): what the steps kept, the result once set, and the first failure. A state that arrives claiming `pass` is refused, as `infra`, since only an `act` job reads `pass`. So is a state that is missing, or is for another scenario or repository, and one that says the scenario ended when its repository records no result.

**What a `kanon` job's code can upload (harness #24).** Kanon's code runs in the same job as that job's later `upload-artifact` steps, whose files it can probably rewrite. Then it can upload an artifact under any name in the run, for its own scenario or another's. Nobody has measured that on a hosted runner yet, so this page assumes it. A `kanon` job runs after the `act` jobs of every earlier phase, so what it plants can replace what they uploaded. So no reader takes a scenario's result from an artifact alone. The Owner's R2 and R3 (2026-10-19) close the gap:

- **The verdict.** `report` reads the verdict and the red issue from the `verdict` job's outputs, which no other job can set. `verdict` uploads `verdict.json`, for people to read, with `overwrite`, so one planted under its name is replaced rather than blocking the upload.
- **The repository records the result (R2).** The `act` job that learns a scenario's result writes it as the repository's topic, `kanon-e2e-passed`, `kanon-e2e-failed` or `kanon-e2e-infra`, before it deletes or archives the repository. Only the act token can set a topic, delete or archive. Every `act` job reads the repository before the state, and a result its topic records is final, whatever the state says. A state that says the scenario ended, with no such topic, is refused as `infra`, and so is any state for a phase the scenario doesn't have. `gate-2` and `gate-3` read the repository too, never the artifact, so a planted result can't cut a running scenario's later phases short.
- **The jobs list records the result (R3).** When an `act` job finalizes a scenario, it runs one step named for the result, `The scenario reads pass`, `… fail` or `… infra`, and skips the other two (`e2e-act-job.yml`, `runner/evidence.mjs`). The run's jobs list is GitHub's, and its job and step names come from this repository's workflows at the run's commit. `verdict` reads it, `GET repos/kanon-e2e/harness/actions/runs/<run id>/attempts/<attempt>/jobs`. A scenario reads the result its first `act` job to finalize it recorded. That job is `act-<n> (<id>) / job / act segment`, so another scenario's job can't stand in for it. A `pass` counts only when that job is the scenario's own last `act` job that ran, and concluded `success`, which its result upload needs. Any other `pass` reads `unconfirmed`, and so does every `pass` when the jobs list can't be read. The artifact gives only the details of the recorded result: the first failure, the steps, the kept repository. An artifact's `fail` or `infra` with nothing recorded stands, since it can only hold a scenario back. `runner/burn-in.mjs` confirms each `pass` the same way, against the run's first attempt. A run from before the result steps existed, whose `act` jobs list none, is still read from its artifact, as it was then.

**What stays open.**

- **The runner's own token.** If Kanon's code can take the `kanon` job's runner token, and that token can still write a step or a job's result after the job ends, the jobs list is no longer GitHub's word alone. That has not been measured, and the Owner holds item 5 of #24, an upload-time check against `act-3`'s completion, until a probe shows it.
- **What a `kanon` segment checks.** An expectation evaluated inside a `kanon` segment, such as `expect.doctor`, runs where Kanon's code runs, so Kanon's code can make it read true. A state planted for a scenario still running can change what its next `act` job reads as kept, the `init` and `doctor` documents among them, which come from a `kanon` job anyway.
- **The ledger's costs.** The real-model ledger still reads `costUsd` from the result artifacts ([below](#the-real-model-ledger)).

No write token is reached, so decision 23 (b) still holds.

## Pass, fail, infra

| Result | When | The repository |
|---|---|---|
| `pass` | The last phase's `act` segment ran every step. | Topic `kanon-e2e-passed`, then deleted. |
| `fail` | An expectation was false, a step's or the scenario's deadline passed (save a push GitHub never delivered, below), the artifact was refused, or the harness's own code went wrong. | Topic `kanon-e2e-failed`, archived, and kept 24 hours (decision 13). |
| `infra` | GitHub failed past the retries, a token expired, GitHub delivered no push run of any kind for the commit `release.cut` or `run.await` on `push` waited on past its deadline (#115), where for `run.await` the commit's tree runs the step's workflow on that push (#126; a tree that doesn't is `fail`), the repository wasn't provisioned or is gone, or the state didn't arrive, or arrived claiming what only the repository records. | Topic `kanon-e2e-infra`, then deleted. |
| `skipped` | The runner refused to start the scenario, and says why in the result's `skipped` field, a short word: `budget` when the real-model ledger (E10) found it could pass the run's $2, and, for a `gate: true` scenario only, `no-history` or `max-model` when the ledger refused it for no recorded cost or for decision 15's two (#107). `plan` refuses it before any repository exists and hands it to `verdict` in its `skipped` output, which `verdict` reads as the scenario's result, over any artifact claiming another. `verdict` reads a counted `skipped` as `fail`, and a `skipped` with no such word as missing. | — |

A call to GitHub, by `gh` or by `git`'s clone, fetch, push and ls-remote, that fails on a 5xx, a rate limit or a network error is retried three times, after 2, 4 and 8 seconds, or a minute on a rate limit. A write that could land twice, a POST, a DELETE, a GraphQL mutation or `gh pr merge`, is asked again only after a lookup says its first attempt didn't land, since GitHub sometimes commits a write before it fails the answer (#130, the Owner 2026-10-25). The lookups are the open pull request for the head (`pr.open`), the open issue of the title and body that no earlier step keeps (`issue.open`), the labels on the issue (`issue.label`, `pr.label`), the label, the milestone and the ruleset by name (`repo.apply`, `ruleset.tags`), the environment's tag rule (`environment.create`), the merge queue's entry or auto-merge (`pr.merge`, `release.cut`), the repository gone (its end, and the janitor), and the upgrade signal's issue by its title and marker. When the write landed, the step uses what it created. A write with no reliable lookup, `workflow.dispatch`'s dispatch and `deployment.await-approval`'s cancel, is asked once, and GitHub's failure reads `infra`, as does a write's answer GitHub cut off that no lookup finds. A PUT or a PATCH sets a whole state, so it is retried as a read is. A false expectation is never retried: it is the finding. The result is set once, and a later phase can't change it. The `act` job that learns the result records it as the repository's topic, then ends the repository, still when the topic can't be written. It runs the step named for the result and uploads `kanon-e2e-result-<scenario>`. The janitor deletes what a dead run left.

## The real-model ledger

`runner/ledger.mjs` holds the real-model tier's $2 a run softly ([Kanon plan 0012](https://github.com/yedeya-labs/kanon/blob/main/docs/plans/0012-end-to-end-tests.md) §6.2, decision 7 as changed; step E10). `plan` asks it, before any repository is created, about each `claude: subscription` scenario the run would hold: the `gate: true` ones first, then the others, each in catalogue order:

| The scenario | The poll, the nightly | A dispatch |
|---|---|---|
| Has recorded costs, and its expected cost fits | started | started |
| Has recorded costs, and its expected cost would pass the $2 | `skipped: budget` | `skipped: budget` |
| Has no recorded cost | not started, with the reason in `plan`'s summary; `skipped: no-history` when it gates | started only when it is the run's one real-model scenario; otherwise not started, `skipped: no-history` when it gates |
| Would be the third real-model scenario (decision 15) | not started; `skipped: max-model` when it gates | not started; `skipped: max-model` when it gates |

- **Its expected cost** is the largest cost its last ten recorded runs reported, times 1.5. **A recorded cost** is a result's `costUsd`: the `kanon-e2e-result-<scenario>` artifacts of `e2e.yml`'s runs on `main`, unexpired, newest first. `expect.row` keeps it from the lane's telemetry row, the run's `total_cost_usd`: Claude Code's own reckoning, priced at list, not a bill on the subscription token (Kanon #968, item 8). It keeps it before comparing it with the lane's ceiling, so a run that went past is still history. A scenario that ended before its row was read records no cost.
- **What the run has already spent.** The admitted scenarios run at once, so at `plan` it is the sum of their expected costs. A scenario is refused when its expected cost would take that sum past `capUsd`.
- **A scenario with no recorded cost** runs only on a dispatch, the Owner's, with no other real-model scenario against the cap. The poll and the nightly leave it out and say why. A `gate: false` one is set aside before the cap, so it takes none of the rotation's slots: the cap fills them with scenarios that start, and its summary names as left out only what the cap kept out (#109). A gating one keeps its place among the gating scenarios (#107). For a `gate: false` scenario that is no result, so it doesn't turn the run red: the Owner's first dispatch of it is what's missing, not a fix.
- **A gating scenario is never refused in silence** (#107). The `gate: true` ones are admitted first, so a `gate: false` one earlier in the catalogue never takes a gating one's place under the $2 or the two. One still refused, for any reason, is handed to `verdict` with its `skipped` word, so a candidate's run reads `fail` rather than `pass` without it.
- **It is soft.** A run that goes past its own history can spend up to its lane's ceiling ($30 for the Reviewer) before the ledger sees it. The lane's `--max-budget-usd` bounds each run, and the subscription's usage limits bound the month.
- **What it trusts** (#24). Code in a `kanon` job can upload a `kanon-e2e-result-<scenario>` artifact under any name in its run, a low `costUsd` included, and the ledger would expect less next time. The lane's own ceiling still bounds each run.

`runner/settings.json`'s `ledger` holds the cap, the margin and the ten runs; `maxModelScenarios` holds decision 15's two. `tests/ledger.test.mjs` holds the rules, and names the two tests E10's mutation turns red: the ledger without its margin, and a scenario with no history started by the schedule.

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

*W* × 10 (provision) + ⌈min(*n*, 2) / 2⌉ × (10 (model key) + 10 (the Author's label, E10)) + 3 × *W* × (25 + 35) (each phase's `kanon` and `act` pairs, mint included) + 2 × 5 (`gate-2` and `gate-3`, one job each, not in waves).

The **catalogue's cap** is the largest *n* whose longest running time fits the nightly interval and whose 2*n* repositories (each scenario, and its re-run) fit the hour's 80. That is **14 scenarios**. 14 scenarios take **22 h 40 min**, so a run ends inside the 24 hours before the next nightly.

**The cap holds what a run plans, not the catalogue** (the Owner, 2026-10-20; `fitCap` in `runner/plan.mjs`). The catalogue may hold more than 14.
- **A nightly, a candidate's run, or a dispatch of the whole catalogue** plans every `gate: true` scenario first, then as many `gate: false` ones as fit under the cap.
- **The rotation is by the UTC day.** The `gate: false` scenarios, sorted by id, are taken in a window as long as the room the gating ones leave, starting at day × room (mod their count). Consecutive days take consecutive windows, so each is planned within ⌈count / room⌉ consecutive days of runs. `plan`'s summary names the ones left out this time. On the poll and the nightly, a `gate: false` real-model scenario with no recorded cost isn't in the rotation: the ledger would refuse it, so it takes no slot (#109). A run that left a scenario out neither counts toward its burn-in nor breaks it.
- **A dispatch of one scenario or a family** plans what it selects, and is refused only when that selection itself passes the cap.
- **When the `gate: true` scenarios alone pass the cap,** `plan` fails, as no run could hold the gate. Then the limit must rise, or a scenario must leave the gate.

**The janitor's cut-offs** follow: the longest running time at the cap, plus 100 minutes' margin for queueing, is **24 h 20 min**. A repository with `kanon-e2e-failed` gets 24 hours more, **48 h 20 min**. It runs hourly (`e2e-janitor.yml`). It deletes only repositories with the `kanon-e2e` topic, never the harness. Its run fails, by name, on a repository older than a day that it couldn't delete.

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
- A counted scenario that read `fail`, or `skipped` (such as `skipped: budget`), gives `fail`. One that read `infra`, left no result, or claims a `pass` the jobs list doesn't confirm (`unconfirmed`, #24), gives `infra-only`, unless another counted scenario failed.
- A candidate's run with no `gate: true` scenario gives `fail`, "no scenario gates yet", never `pass`.
- While the candidate's red issue is open and holds a `fail`, every run of that candidate gives `fail`, whatever its scenarios did.

## The upgrade signal's jobs

`.github/workflows/upgrade-signal.yml` runs weekly and on dispatch, outside `e2e.yml` (plan 0012 step E14; [the README](../README.md#the-upgrade-signal)). It splits as a scenario's phase does: Kanon's code in one job, the harness's in another, and only the second writes. Its only credential is the workflow's token. `tests/upgrade-signal.test.mjs` holds it to this table.

| Job | Environment | Holds | Does |
|---|---|---|---|
| `doctor` | none | the workflow's own token: `actions`, `checks`, `contents`, `issues` read | Checks out `main`, with its history, and runs `kanon doctor --json` there with `npx`, at the one release the harness's workflows pin. Keeps the document as the `upgrade-signal-doctor` artifact. Writes nothing to GitHub. |
| `signal` | none | the workflow's own token: `actions` and `contents` read, `issues: write` | Runs `runner/upgrade-signal.mjs`, the harness's code alone: reads doctor's document as data, Kanon's releases and the latest completed `release.yml` run on `main`, then opens, edits or closes the one `long-lived upgrade behind` issue. |

**What `doctor`'s code can reach.** The release the harness pins runs with read permissions, so the worst it can do is plant a document that reads healthy, which only keeps the issue closed. That is the same release every lane of the harness already runs.
