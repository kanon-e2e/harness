# `deploy-rehearsal-mutant` (temporary)

The mutation evidence for `deploy-rehearsal` (#26, #29). It is a copy of [`deploy-rehearsal`](../deploy-rehearsal/README.md) with one expectation broken. After the failing smoke check's release, it expects the staging issue to be closed, so in effect it expects no open issue. The deploy lane files that issue open, so this copy must read `fail`.

It runs once, by dispatch (`select=deploy-rehearsal-mutant`). Its run and its `kanon-e2e-result/v1` document are linked on #26 and #29, and then this directory is removed. Its `gate` is `false`, so it never counts toward the release gate. Until it is removed, a nightly or a `select=deploy` dispatch runs it too, and it reads `fail` there as well.
