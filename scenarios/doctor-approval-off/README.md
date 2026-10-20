# Doctor broken: bootstrap ended without the approval

Kanon's plan 0012 step E12, the doctor-broken family (§6.1): one scenario per finding category of Kanon's `docs/doctor.md`, each a clean install with one thing broken. This one is the `ruleset` category's guard on the end of bootstrap (K-ADOPT-6). It installs Kanon's **Review** feature as [`install-review`](../install-review/README.md) does, at the release under test, and writes `ended` in the adoption record, but never requires the approving review in the ruleset. An adopter who records the date and forgets the setting, or switches the approval off later, makes this mistake: every merge then needs no approval. Doctor must report exactly `ruleset.approval-off`, and nothing else that blocks.

`scenario.json`: family `doctor`, tier `none`, Claude `none`, `judge` as its test Apps (the `review` feature's Apps in the release's `requirements.json`), and `gate: false`: it is new, so its result changes nothing on a candidate's run until it has passed ten runs in a row, scheduled or dispatched (Kanon plan 0012 §10, decision 24).

## What the repository holds

`start/` is one file, a `README.md` that names the scenario, the release and the repository (`{{release}}` and `{{repository}}` filled in). The repository is otherwise empty, as a new adopter's is.

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
| 1 | `act` | `bootstrap.end` with `record`: `ended <today>` under `## Bootstrap` in the adoption record, in a second push | |
| 1 | `act` | `repo.apply` with `firstCommit`: the labels, the bucket milestones, and the ruleset | |
| 1 | `act` | `workflow.dispatch` of `apps-check.yml`, then `run.await` for its run | |
| 1 | `act` | `expect.run` | The run concluded `success`, with `apps / Judge` `success`. |
| 1 | `act` | `run.await` for `ci.yml`'s run on the push | |
| 1 | `act` | `expect.check` | `Lane check` on the default branch's head concluded `success`. |
| 1 | `act` | `repo.apply` again: the ruleset's required `Lane check` rule | |
| 1 | `act` | **The break:** no `bootstrap.end` with `approval`, so the ruleset requires no approving review | |
| 2 | `kanon` | `kanon.doctor` on the default branch | |
| 2 | `kanon` | `expect.doctor` | Status `findings`, exit code 1, and only `secrets` unchecked. `ruleset.approval-off` is reported, and `blocking` holds it as the one blocking finding: the record says bootstrap ended and no ruleset requires an approval. Doctor's reminder, `ruleset.bootstrap-can-end`, would block too, but only while the record says bootstrap is still on, so `blocking` also proves doctor reads the record's `ended` line. `/releases/pins` equals `["{{release}}"]` and `/releases/pinned` equals `{{release}}`. |

`{{release}}` in an expectation is filled in with the release under test before comparing ([`scenarios/README.md`](../README.md#substitutions-in-stepsjson)).

**Why exit code 1, with `secrets` unchecked.** Doctor's status is `findings`, and its exit code 1, whenever a finding blocks, even with a check it couldn't run; `incomplete` and 4 are for a run with nothing blocking (Kanon's `docs/doctor.md`, "Exit codes"). The `kanon` job's read-only token still can't list the secrets (probe 19), so `secrets` stays the one check allowed `unchecked`.

**Why `blocking` and not a list of `absent` ids.** `blocking` holds the document's blocking findings to exactly the one id: any other finding that blocks fails it, including one Kanon adds in a later release. A finding that blocks nothing, such as `pin.candidate` at a candidate or `deploy.reference-undeclared`, may be reported.

**Run it at the newest unpromoted candidate, or at a stable release,** for the reason [`install-review`](../install-review/README.md#the-steps) gives: once a candidate is promoted, `init` pins the stable tag, and `/pin` fails.

## What it creates

One public repository in `kanon-e2e`, `e2e-doctor-approval-off-<run>-<attempt>`, holding what `install-review`'s holds, except the required approving review: the review lane's caller, the `apps-check` and `ci.yml` callers, the adoption record and declarations `init` writes, the register's rows for `judge`, the release's labels, the bucket milestones, the ruleset with its `Lane check` rule and no required approval, the adoption record's `ended` line, and the runs of `apps-check` and of `ci.yml` on each push.

The repository is deleted when the scenario passes. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 15 minutes, an estimate until the first dispatch measures it: `provision`, two `kanon` jobs, one `act` job, and the two runs it waits for. The scenario's deadline is 60 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **People:** none.

## When it is red

The failing job's summary names the first failure. A failure before phase 2 is an install failure: read [`install-review`'s list](../install-review/README.md#when-it-is-red), which takes the same steps. In phase 2, what it usually means:

- **`expect.doctor` on `ruleset.approval-off` not reported.** Doctor no longer guards an ended bootstrap, or reads the ruleset's approval where `bootstrap.end` doesn't set it: read Kanon's `docs/doctor.md` at the release. If `ruleset.bootstrap-can-end` blocks in its place, doctor didn't read the record's `ended` line: Kanon changed the record's layout (K-LAYOUT-10), and `bootstrap.end` follows it.
- **`expect.doctor` on the status or the exit code** with `ruleset.approval-off` reported: doctor no longer blocks on it, which K-ADOPT-6 forbids, since the guard can't be waived.
- **`expect.doctor` on another blocking finding.** Doctor blocks on something besides the break. If `install-review` fails on the same finding at the same release, the install is broken, not this scenario. If only this scenario fails on it, the break leaks into a second check: a finding against Kanon's doctor, unless Kanon meant it.
- **`expect.doctor` on `unchecked`.** Another check couldn't run: the `kanon` job's token reads less than it did, or doctor needs more.
- **`expect.doctor` on `/releases/pins`.** Some file pins a release other than the one under test, or two releases are pinned.
