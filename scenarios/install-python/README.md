# Install: a Python project

Kanon's plan 0012 step E6 (harness #41): Kanon's **Review + build** feature into a Python project, not an empty tree, with two Apps. It installs `build` because the build lanes are what run the project's `project-setup` hook. The scenario installs it into a fresh repository the way an adopter does, at the release under test, and checks that doctor then finds the repository healthy, with every Kanon reference in it pinned to the release under test and only it.

`scenario.json`: family `install`, tier `none`, Claude `none`, `author` and `judge` as its test Apps (the `build` feature's Apps in the release's `requirements.json`), and `gate: false`. It counts toward the release gate only after burn-in (step E9) and the Owner's decision.

## What the repository holds

`start/` is the Python project of Kanon's [`tests/fixtures/python-adopter/`](https://github.com/yedeya-labs/kanon/tree/candidate-v0.41.0/tests/fixtures/python-adopter) at `candidate-v0.41.0`, copied as it is. No file in it holds a substitution.

| Taken | What it is |
|---|---|
| `pyproject.toml` | The project, `orders`, Python 3.12 or later, with `pytest` as its `test` extra. |
| `src/orders/__init__.py`, `src/orders/core.py` | Its code: one function, `place`. |
| `tests/test_core.py` | Its two tests, on pytest. |
| `.gitignore` | `.venv/` and `__pycache__/`. |
| `.github/actions/project-setup/action.yml` | Its `project-setup` hook: Python 3.12, and `pip install -e ".[test]"`. The build lanes run it. |

Left out, and why:

| Left out | Why |
|---|---|
| `.github/workflows/` (`agent-implement.yml`, `agent-implement-revise.yml`, `agent-lead-revise.yml`, `agent-triage.yml`) | Kanon's callers, pinned to `v1.2.3`, a release that doesn't exist. `init` writes the callers, pinned to the release under test; with these the scenario would test stale pins, not a fresh install. |
| `docs/qa/agent-identities.md` | The fixture's App register. `register.write` writes this scenario's, with the test organisation's Apps; with it the scenario would test someone else's register. |
| `docs/qa/stack.md`, `docs/qa/escalation-paths.md`, `docs/qa/exemptions.md`, `docs/qa/triage-fix-playbook.md`, `docs/qa/specs/`, `docs/design.md`, `docs/projects/1.md` | The fixture's declarations and documents under `docs/`, which `init` writes or a project writes later. A fresh install starts without them. |
| `.github/dependabot.yml` | Its Dependabot entry, which `init` writes for the Kanon pins. |
| `scripts/pipeline/triage.py` | A script of the fixture's for Kanon's own citation tests, which a fresh install has no use for. |

To take it again at a later release, copy the six files above from the fixture at that release's tag, and update this section.

## The flags

`kanon.init` always runs `kanon init --json --yes --no-apps --consent no`: no Apps created, telemetry and sharing declined (decision 8). The scenario adds:

- `--feature=build`.
- `--review-trigger=labelled`: the Reviewer reviews a pull request once it is labelled `review:please`, the only trigger Kanon builds yet.
- `--no-sensitive-data`: the adoption record's `## Data` section declares no sensitive material.

## The steps

The order matters. `repo.apply`'s ruleset requires a pull request on the default branch and lets no one bypass it, so every push to the default branch happens before it exists.

| Phase | Job | Step | What it expects |
|---|---|---|---|
| 1 | `kanon` | `kanon.init` with the flags above | |
| 1 | `kanon` | `register.write`: the App register's rows for `author` and `judge` | |
| 1 | `kanon` | `expect.init` | Status `steps-left`. The findings `label.create`, `milestone.buckets`, `ruleset.create` and `ruleset.require-check`: what `init` leaves to a person, on a token that can't do it. `/pin` equals `{{release}}`. |
| 1 | `act` | `files.commit` from the `kanon` job, to the default branch, in one push | |
| 1 | `act` | `repo.apply`: the labels, the bucket milestones and the ruleset | |
| 1 | `act` | `workflow.dispatch` of `apps-check.yml`, then `run.await` for its run | |
| 1 | `act` | `expect.run` | The run concluded `success`, with `apps / Author` and `apps / Judge` each `success`: one job per App the register lists, so every App the scenario lists was checked against its installation. |
| 1 | `act` | `run.await` for `ci.yml`'s run on the push | |
| 1 | `act` | `expect.check` | `Lane check` on the default branch's head concluded `success`. |
| 1 | `act` | `repo.apply` again: the ruleset's required `Lane check` rule, now that a run reports it | |
| 2 | `kanon` | `kanon.doctor` on the default branch | |
| 2 | `kanon` | `expect.doctor` | Status `incomplete`, exit code 4, and only `secrets` unchecked: the `kanon` job's read-only token can't list the secrets (probe 19). `incomplete` means nothing blocking was found. `/releases/pins` equals `["{{release}}"]` and `/releases/pinned` equals `{{release}}`. |

`{{release}}` in an expectation is filled in with the release under test before comparing ([`scenarios/README.md`](../README.md#substitutions-in-stepsjson)).

**Run it at the newest unpromoted candidate, or at a stable release.** At a candidate, `init` pins the candidate, because the stable tag doesn't exist yet (Kanon's E1, released in `candidate-v0.41.0`). Once the candidate is promoted, `init` prefers the stable tag: `/pin` reads `vX.Y.Z`, not `{{release}}`, and the scenario fails. The nightly picks a candidate only while it is newer than the stable, and the poll runs the latest candidate.

## What it creates

One public repository in `kanon-e2e`, `e2e-install-python-<run>-<attempt>`, holding the following:

- the callers of the build feature's eight lanes; the project's own `project-setup` hook stays, since `init` writes a stub only where no file is, the `apps-check` and `ci.yml` callers, and the adoption record and declarations `init` writes, all pinned to the release under test;
- the App register's rows for `author` and `judge`;
- the release's labels, the bucket milestones, and the default branch's ruleset with its `Lane check` rule;
- two workflow runs: `apps-check` and `ci.yml`'s push run.

The repository is deleted when the scenario passes. When it fails, it is archived for 24 hours, with the `kanon-e2e-failed` topic.

## What it costs

- **Time:** about 15 minutes, an estimate until the first dispatch measures it: `provision`, two `kanon` jobs, one `act` job, and the two runs it waits for. The scenario's deadline is 60 minutes.
- **Minutes:** the scenario repository and the harness are both public, so their runs cost nothing (probe 6).
- **People:** none.

## When it is red

The failing job's summary names the first failure. What it usually means:

- **`expect.init` on `/pin`.** `init` pinned another release than the one under test. Most often the candidate was already promoted (above). Otherwise E1's pin rule regressed.
- **`expect.init` on a finding.** `init` now applies something itself, or names it differently. A finding no longer reported is what `repo.apply` would no longer apply: check Kanon's `docs/init.md` at the release.
- **`expect.run` on `apps-check`.** A job failed: the App's installation doesn't match what the release's `requirements.json` asks of it, or its secrets are missing (`provision` writes them). A job not in the run means the register lacks that App's rows, or Kanon renamed the job.
- **`expect.check` on `Lane check`.** `lane-check` refused what `init` wrote, at the same release: that is a finding against Kanon.
- **The second `repo.apply`.** No ruleset named as `init` names it: the first `repo.apply` didn't create it.
- **`expect.doctor` on the status or the exit code.** Doctor found something blocking on a fresh install: a finding against `init`, or against the steps the harness takes in a person's place. Its `findings` say which.
- **`expect.doctor` on `unchecked`.** Another check couldn't run: the `kanon` job's token reads less than it did, or doctor needs more.
- **`expect.doctor` on `/releases/pins`.** Some file pins a release other than the one under test, or two releases are pinned.
- **`expect.init` or `expect.doctor` on a finding about the project itself.** Kanon read the Python project differently from an empty tree: a stack it doesn't recognise, or a hook it holds malformed. The project is Kanon's own fixture, so a change there at a later release may need `start/` taken again (below).
