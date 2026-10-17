# Escalation paths

The harness's escalation file (`K-LAYOUT-8`). The harness is Kanon's end-to-end tier, and its runner acts with the driver App's key, which can create and delete repositories in the test organisation and change this one. So every change to what runs with that key is the Owner's to merge, from the first commit (Kanon plan 0012 §3, decision 17). The Merger reads this file from the default branch (`K-MERGE-17`), and the file is directly inside `docs/qa/`, so a pull request that changes it goes to the Owner too.

Three tiers decide who merges a pull request here:

- **Always the Owner, fixed by `K-MERGE-4`, so not declared here:** every file under `.github/`, every markdown file directly inside `docs/qa/`, `AGENTS.md`, `CLAUDE.md` and `.claude/`.
- **The Owner, by the harness's choice:** the paths below, each marked `always`, so they stay the Owner's even if the adoption record ever declares a human-gated production promotion (`K-MERGE-4`, `K-LAYOUT-10`). Each is a pattern, not a list of files, so the first pull request that adds a matching file is already the Owner's. The workflow patterns repeat what `K-MERGE-4` already holds for `.github/`, on purpose: they say why, and they stay if that rule ever narrows.
- **Green, everything else:** the Merger may merge it, such as `README.md`, `probes/README.md` and `tests/`.

The escalation test, `tests/escalation-paths.test.mjs`, holds each of these patterns on the `always` list.

## Escalation paths

- `^runner/` `always` — the runner's modules: the runner, its verbs, its GitHub client and its scenario validator, which run in the `act` jobs with the driver's token (plan 0012 §5.2)
- `^janitor/` `always` — the janitor's modules, which run with the driver's unscoped token and delete the test organisation's repositories (plan 0012 §5.3)
- `^\.github/workflows/e2e[^/]*\.ya?ml$` `pipeline` `always` — `e2e.yml`, `e2e-janitor.yml` and every `-run` and `-job` pair: they mint the driver's and the Reporter's tokens and hand them to the runner and the janitor (plan 0012 §5.2)
- `^\.github/workflows/probe-[^/]*\.ya?ml$` `pipeline` `always` — the probes, which read the driver's key from `e2e`, and probe 13 the Reporter's from `e2e-report` (probes/README.md)
- `^package(?:-lock)?\.json$` `always` — the harness's dependencies, which the runner and the janitor will load in the jobs that hold the driver's token

Every workflow that reads an environment's key is named `e2e*.yml` or `probe-*.yml`, so one of the two patterns above covers it. The escalation test reads every workflow that names an environment and fails on one neither covers: name such a workflow to match, or add its pattern here.

## Pipeline code

None: the harness keeps no pipeline scripts of its own outside `.github/`, which `K-MERGE-4` already holds.
