# Doctor broken: an unaccepted id-token holder

Kanon's plan 0012 step E12, the doctor-broken family (§6.1): one scenario per finding category of Kanon's `docs/doctor.md`, each a clean install with one thing broken. This one is the `id-token` category. It installs Kanon's **Review** feature as [`install-review`](../install-review/README.md) does, at the release under test, and adds a workflow of the adopter's own whose job holds `id-token: write`, which the adoption record doesn't accept under `## Choices`. On the default branch such a job could assume any cloud role that trusts the branch's ref, Kanon's store roles among them. An adopter who adds a publish or deploy workflow and forgets to accept it, or to narrow its grant, makes this mistake. Doctor must report exactly `id-token.unaccepted`, and nothing else that blocks.

`scenario.json`: family `doctor`, tier `none`, Claude `none`, `judge` as its test Apps (the `review` feature's Apps in the release's `requirements.json`), and `gate: false`: it is new, so its result changes nothing on a candidate's run until it has passed ten runs in a row, scheduled or dispatched (Kanon plan 0012 §10, decision 24).

## What the repository holds

`start/` is one file, a `README.md` that names the scenario, the release and the repository (`{{release}}` and `{{repository}}` filled in). The repository is otherwise empty, as a new adopter's is.

`id-token/` is the break, a tree of one file that `files.commit` pushes: `.github/workflows/publish.yml`, a workflow named `Publish` that runs only when dispatched, with `permissions: {}` and one job, `publish`, holding `contents: read` and `id-token: write`. Its one step echoes a line. The scenario never dispatches it, and `lane-check` doesn't read it: it calls no Kanon workflow.

## The flags

`kanon.init` always runs `kanon init --json --yes --no-apps --consent no`: no Apps created, telemetry and sharing declined (decision 8). The scenario adds the same flags as [`install-review`](../install-review/README.md):

- `--feature=review`.
- `--review-trigger=labelled`.
- `--no-sensitive-data`.

## The steps

The install is [`install-review`](../install-review/README.md)'s, step for step, except where the table says **the break**. Every push to the default branch happens before `repo.apply` creates the ruleset, which lets no one bypass it.

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon` | `kanon.init` with the flags above | |
| 1 | `kanon` | `register.write`: the App register's rows for `judge` | |
| 1 | `kanon` | `expect.init` | Status `steps-left`, the findings `label.create`, `milestone.buckets` and `ruleset.first-commit`, and `/pin` equals `{{release}}`, as `install-review`. |
| 1 | `act` | `files.commit` from the `kanon` job, to the default branch, in one push | |
| 1 | `act` | **The break:** `files.commit` of `id-token/`, the `Publish` workflow, to the default branch, in a second push | |
| 1 | `act` | `bootstrap.end` with `record`: `ended <today>` under `## Bootstrap` in the adoption record, in a third push | |
| 1 | `act` | `repo.apply` with `firstCommit`: the labels, the bucket milestones, and the ruleset | |
| 1 | `act` | `workflow.dispatch` of `apps-check.yml`, then `run.await` for its run | |
| 1 | `act` | `expect.run` | The run concluded `success`, with `apps / Judge` `success`. |
| 1 | `act` | `run.await` for `ci.yml`'s run on the push | |
| 1 | `act` | `expect.check` | `Lane check` on the default branch's head concluded `success`. |
| 1 | `act` | `repo.apply` again: the ruleset's required `Lane check` rule | |
| 1 | `act` | `bootstrap.end` with `approval`: one required approving review in the ruleset, dismissed on push | |
| 2 | `kanon` | `kanon.doctor` on the default branch | |
| 2 | `kanon` | `expect.doctor` | Status `findings`, exit code 1, and only `secrets` unchecked. `id-token.unaccepted` is reported, and `blocking` holds it as the one blocking finding: the `publish` job of `.github/workflows/publish.yml` holds the grant and is neither Kanon's lane nor accepted. `id-token.stale-acceptance` is absent: the record accepts no job. `/releases/pins` equals `["{{release}}"]` and `/releases/pinned` equals `{{release}}`. |

`{{release}}` in an expectation is filled in with the release under test before comparing ([`scenarios/README.md`](../README.md#substitutions-in-stepsjson)).

**Why exit code 1, with `secrets` unchecked.** Doctor's status is `findings`, and its exit code 1, whenever a finding blocks, even with a check it couldn't run; `incomplete` and 4 are for a run with nothing blocking (Kanon's `docs/doctor.md`, "Exit codes"). The `kanon` job's read-only token still can't list the secrets (probe 19), so `secrets` stays the one check allowed `unchecked`.

**Why `blocking` and not a list of `absent` ids.** `blocking` holds the document's blocking findings to exactly the one id: any other finding that blocks fails it, including one Kanon adds in a later release. A finding that blocks nothing, such as `pin.candidate` at a candidate or `deploy.reference-undeclared`, may be reported.

**Run it at the newest unpromoted candidate, or at a stable release,** for the reason [`install-review`](../install-review/README.md#the-steps) gives: once a candidate is promoted, `init` pins the stable tag, and `/pin` fails.

## What it creates

One public repository in `kanon-e2e`, `e2e-doctor-id-token-<run>-<attempt>`, holding what `install-review`'s holds, and the `Publish` workflow: the review lane's caller, the `apps-check` and `ci.yml` callers, the adoption record and declarations `init` writes, the register's rows for `judge`, the release's labels, the bucket milestones, the ruleset with its `Lane check` rule and one required approving review, the adoption record's `ended` line, `.github/workflows/publish.yml`, and the runs of `apps-check` and of `ci.yml` on each push. `Publish` never runs.

The repository is deleted when the scenario passes. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 15 minutes, an estimate until the first dispatch measures it: `provision`, two `kanon` jobs, one `act` job, and the two runs it waits for. The scenario's deadline is 60 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **People:** none.

## When it is red

The failing job's summary names the first failure. A failure before phase 2 is an install failure: read [`install-review`'s list](../install-review/README.md#when-it-is-red), which takes the same steps. In phase 2, what it usually means:

- **`expect.doctor` on `id-token.unaccepted` not reported.** Doctor no longer counts a job's own `id-token: write` as a holder, or counts it as Kanon's own: read Kanon's `docs/doctor.md` at the release, "The id-token holders".
- **`expect.doctor` on the status or the exit code** with `id-token.unaccepted` reported: doctor no longer blocks on an unaccepted holder.
- **`expect.doctor` on another blocking finding.** Doctor blocks on something besides the break. If `install-review` fails on the same finding at the same release, the install is broken, not this scenario. If only this scenario fails on it, the break leaks into a second check: a finding against Kanon's doctor, unless Kanon meant it.
- **`expect.doctor` on `unchecked`.** Another check couldn't run: the `kanon` job's token reads less than it did, or doctor needs more.
- **`expect.doctor` on `/releases/pins`.** Some file pins a release other than the one under test, or two releases are pinned.
