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
- **Upstream findings:** `sent with evidence`
- **Chat channel:** none yet
- **Waived doctor finding:** `notify.none` on `.github/actions/notify/action.yml` (no chat channel is chosen: the harness posts nothing, and the project digest's health job still files its issues)
- **Waived doctor finding:** `deploy.reference-undeclared` on `docs/qa/adoption.md` (the harness deploys nothing: it declares no environment, and its end-to-end runs come from `main`, not from its releases)
- **Waived doctor finding:** `secret.missing` on `kanon-e2e/harness` for `KANON_TELEMETRY_READER_ROLE` (an optional secret no job reads, asked for by mistake: https://github.com/yedeya-labs/kanon/issues/1090; remove this waiver once that fix is released and pinned)

**Telemetry is on** ([`docs/sharing.md`](https://github.com/yedeya-labs/kanon/blob/main/docs/sharing.md), the Owner's decision of 2026-10-17): `.github/workflows/telemetry.yml`, which `kanon init --telemetry --upstream-findings sent-with-evidence` wrote, calls Kanon's collector, and its first run on `main` registers the harness. The Overseer's upstream findings, what it finds about Kanon itself, and the telemetry Explorer's once that lane is installed, are sent with their evidence over that channel, and drafted here as well. The scenario repositories send neither (Kanon plan 0012, decision 8).

## Data

Whether this repository holds private or sensitive material, as declared at install. The lanes read the files and diffs their work needs either way.

- **Private or sensitive material:** `no`
