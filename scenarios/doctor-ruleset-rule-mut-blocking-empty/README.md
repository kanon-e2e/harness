# Temporary: `doctor-ruleset-rule`, mutated so nothing blocks

**Temporary.** This copy exists for one dispatch, Kanon plan 0012 step E12's mutation check: it proves [`doctor-ruleset-rule`](../doctor-ruleset-rule/README.md) goes red when the property it guards breaks. It is deleted after that dispatch.

**What it mutates.** [`doctor-ruleset-rule`](../doctor-ruleset-rule/README.md), step for step, with one change: the second `repo.apply` (`firstCommit: true`) that the original leaves out is put back, before `bootstrap.end` with `approval`. The ruleset then requires `Lane check`, so the break is undone and doctor has nothing to block on.

**The expected red step.** Phase 2's `expect.doctor`. The original holds doctor to status `findings`, exit code 1, `ruleset.rule-missing` reported, and `blocking: ["ruleset.rule-missing"]`. Here doctor's blocking findings are empty (status `incomplete`, exit code 4), so the expectation must fail. Everything before it must pass: a failure earlier is an install failure, not the mutation.

`scenario.json`: as the original's, with `gate: false` and `runsOn: ["dispatch"]`, so the poll and the nightly never run it. Dispatch it by its id:

```sh
gh workflow run e2e.yml -R kanon-e2e/harness -f release=<candidate> -f select=doctor-ruleset-rule-mut-blocking-empty
```

Don't dispatch the `doctor` family while this copy exists: a family `select` includes a scenario whose `runsOn` names `dispatch`, so this one would turn that run red.
