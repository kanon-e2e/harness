# Stack

The project's stack document (`K-LAYOUT-17`), started by `kanon init`. The sections it leaves out mean their documented defaults: no schema changes, nothing to isolate, no generated files, and the whole repository as code.

The harness is Node 24, with its tests on Vitest. Its dependencies are in `package.json`, pinned exactly, and `package-lock.json`.

## Code areas

- `tests/` `vitest` — tests: the harness's own tests, and their helpers

## Gates

Run these before every push, in this order, from the repository root. CI runs both on every pull request (`.github/workflows/ci.yml`).

1. `npm ci`, then `npm test`, which runs every test under `tests/` on Vitest: among them the escalation test (`tests/escalation-paths.test.mjs`) and the workflow test (`tests/workflows.test.mjs`)
2. Kanon's `lane-check`, which CI runs as the `Lane check` job. To run it locally, from a checkout of Kanon at the release the callers pin: `ACTION_REF=<that release> bash <kanon>/actions/lane-check/lane-check.sh`

There is no build and no end-to-end tier of the harness's own.
