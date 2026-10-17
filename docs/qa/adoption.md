# Adoption record

`kanon-e2e/harness` adopts Kanon. This is its adoption record (`K-LAYOUT-10`), started by `kanon init` on 2026-10-17. A section or choice it leaves out means its documented default.

## People

| Role | Who |
|---|---|
| Owner | `@yedeya` |
| Maintainer | `@yedeya` |
| Stakeholder | `@yedeya` |

## Plan

`kanon-e2e/harness` is a **public repository on an organisation** (`K-ADOPT-2`). Of the platform features of `K-ADOPT-3`:

- **Rulesets:** available.
- **Merge queue:** available.
- **Environments:** no Kanon lane needs one.

## Bootstrap

`ended 2026-10-17`

## Choices

- **Feature:** `full`
- **Review trigger:** `labelled`
- **Overseer:** `installed`
- **Chat channel:** none yet
- **Waived doctor finding:** `notify.none` on `.github/actions/notify/action.yml` (no chat channel is chosen: the harness posts nothing, and the project digest's health job still files its issues)
- **Waived doctor finding:** `deploy.reference-undeclared` on `docs/qa/adoption.md` (the harness deploys nothing: it declares no environment, and its end-to-end runs come from `main`, not from its releases)
- **Waived doctor finding:** `secret.missing` on `kanon-e2e/harness` for `KANON_TELEMETRY_READER_ROLE` (an optional secret no job reads, asked for by mistake: https://github.com/yedeya-labs/kanon/issues/1090; remove this waiver once that fix is released and pinned)

## Data

Whether this repository holds private or sensitive material, as declared at install. The lanes read the files and diffs their work needs either way.

- **Private or sensitive material:** `no`
