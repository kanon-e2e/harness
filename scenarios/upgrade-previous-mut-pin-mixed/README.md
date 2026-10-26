# Temporary: `upgrade-previous`, mutated to leave a mixed pin

**Temporary.** This copy exists for one dispatch, Kanon plan 0012 step E12's mutation check: it proves [`upgrade-previous`](../upgrade-previous/README.md) goes red when the property it guards breaks, every Kanon reference pinned to the release under test and only it. It is deleted after that dispatch.

**What it mutates.** [`upgrade-previous`](../upgrade-previous/README.md), step for step, with one change: one added `files.commit` of `stale-pin/` on the branch `upgrade`, after the kanon segment's files and before `pr.open`. It puts back one caller, `.github/workflows/apps-check.yml`, as the release under test's `init` writes it but pinned to `v0.40.2`, as if `pins.move` had missed that one file. Every other reference pins the release under test, so the upgrade's tree pins two releases.

`v0.40.2` is `previous` while the release under test is `candidate-v0.42.0`. Dispatch it at a release other than `v0.40.2`, or the pins don't mix.

**The expected red step.** Phase 2's `expect.check` on `Lane check` on the `upgrade` pull request: lane-check's one-version rule (`K-ADOPT-11`) refuses two pinned releases, so it reads `failure`, not `success` ([`lane-check-mixed-pin`](../lane-check-mixed-pin/README.md) showed that rule catches this exact caller at `candidate-v0.42.0`). The final `expect.doctor`, which reads `pin.mixed` on this tree, is never reached: the pull request can't merge with `Lane check` failing, so the scenario stops at the first guard of the same property.

`scenario.json`: as the original's, with `gate: false` and `runsOn: ["dispatch"]`, so the poll and the nightly never run it. Dispatch it by its id:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=upgrade-previous-mut-pin-mixed
```

Don't dispatch the `upgrade` family while this copy exists: a family `select` includes a scenario whose `runsOn` names `dispatch`, so this one would turn that run red.
