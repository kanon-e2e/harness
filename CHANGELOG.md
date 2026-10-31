# Changelog

## [0.2.0](https://github.com/kanon-e2e/harness/compare/v0.1.0...v0.2.0) (2026-10-31)


### Features

* **deploy-rehearsal:** gate: true, after ten passes in a row (plan 0012 E9) ([#58](https://github.com/kanon-e2e/harness/issues/58)) ([3108c71](https://github.com/kanon-e2e/harness/commit/3108c713f8c8c8148f50ff15fb1a79af31879726))
* **doctor:** the doctor-broken family, three scenarios at gate: false (plan 0012 E12) ([#90](https://github.com/kanon-e2e/harness/issues/90)) ([546dafc](https://github.com/kanon-e2e/harness/commit/546dafcb20a61d4be21ce13aa9f73b3b41cb10a2))
* **install-build:** gate: true, after ten passes in a row (plan 0012 E9) ([#72](https://github.com/kanon-e2e/harness/issues/72)) ([b02b769](https://github.com/kanon-e2e/harness/commit/b02b76980784724dc6facec4c771ab1c01e48fcf))
* **install-full:** gate: true, after ten passes in a row (plan 0012 E9) ([#75](https://github.com/kanon-e2e/harness/issues/75)) ([2a94572](https://github.com/kanon-e2e/harness/commit/2a94572cfce43255488d0eb51b4f936a27463446))
* **install-python:** gate: true, after ten passes in a row (plan 0012 E9) ([#77](https://github.com/kanon-e2e/harness/issues/77)) ([f0f19c0](https://github.com/kanon-e2e/harness/commit/f0f19c02872a93ab0d7574972c7da814be5d92bb))
* **install-review:** gate: true, after ten passes in a row (plan 0012 E9) ([#78](https://github.com/kanon-e2e/harness/issues/78)) ([b81b728](https://github.com/kanon-e2e/harness/commit/b81b7281c5879520a5e91bf4ee317d24389c3736))
* **lane-check:** the lane-check scenario family (plan 0012 E12) ([#93](https://github.com/kanon-e2e/harness/issues/93)) ([c40f83d](https://github.com/kanon-e2e/harness/commit/c40f83deb1962839da0c17544edc6224b56cd168))
* **ledger:** the real-model tier: the ledger, model-key gating, expect.row and review-real (plan 0012 E10) ([#104](https://github.com/kanon-e2e/harness/issues/104)) ([bac7169](https://github.com/kanon-e2e/harness/commit/bac71699cac2224185bc6e7a379cf3f50c0eb0cc))
* **plan:** runsOn keeps a scenario to its kinds of run; a nightly re-run isn't self-held; mint the label token only for kept scenarios ([#141](https://github.com/kanon-e2e/harness/issues/141)) ([42d1d98](https://github.com/kanon-e2e/harness/commit/42d1d98dfc8a0f131dd3374696eb5c8ae5a59b76))
* **refuse:** the gate refusals, two scenarios at gate: false (plan 0012 E12) ([#98](https://github.com/kanon-e2e/harness/issues/98)) ([9c19fa8](https://github.com/kanon-e2e/harness/commit/9c19fa89abd0f3a484c5fa37eb2fc7f23c8d3d9f))
* runner/burn-in.mjs, a scenario's run of passes toward gate: true (plan 0012 E9, part of [#43](https://github.com/kanon-e2e/harness/issues/43)) ([#50](https://github.com/kanon-e2e/harness/issues/50)) ([e7d9643](https://github.com/kanon-e2e/harness/commit/e7d96431dd5a843ff3b79574d58dab8369c8ae1e))
* **scenario:** notify-revoked, a dead chat webhook turns notify red; the Author dispatches the digest ([#145](https://github.com/kanon-e2e/harness/issues/145)) ([94a4e79](https://github.com/kanon-e2e/harness/commit/94a4e79d5fe0a5bb729854c97046f32848065a17))
* the deploy rehearsal, the first scenario (plan 0012 E5) ([#28](https://github.com/kanon-e2e/harness/issues/28)) ([b585332](https://github.com/kanon-e2e/harness/commit/b585332df7e2d7a8f732f7e1fe15144fb847b918))
* the install scenarios, each pinned to the release under test (plan 0012 E6) ([#44](https://github.com/kanon-e2e/harness/issues/44)) ([5823f86](https://github.com/kanon-e2e/harness/commit/5823f86fcea96f829510cd41a61e792a8af5b2bc))
* the release gate's evidence: the verdict over gating scenarios, the red issue per candidate, and the Reporter's check run (plan 0012 E8) ([#46](https://github.com/kanon-e2e/harness/issues/46)) ([300fb85](https://github.com/kanon-e2e/harness/commit/300fb8572c8c031958a2eb25957d69990c4cdf41))
* the runner, the janitor and the end-to-end workflows (plan 0012 E4) ([#22](https://github.com/kanon-e2e/harness/issues/22)) ([9b18e24](https://github.com/kanon-e2e/harness/commit/9b18e244921fec786c7dd9c61363282ba97c20d2))
* the scenario format, its validator and the step vocabulary ([#18](https://github.com/kanon-e2e/harness/issues/18)) ([9dc1f96](https://github.com/kanon-e2e/harness/commit/9dc1f96b46fbba4e0e9a9afb9a37c7a782b2b831))
* the upgrade scenarios, from each of the last two stable releases to the release under test (plan 0012 E7) ([#51](https://github.com/kanon-e2e/harness/issues/51)) ([386bc11](https://github.com/kanon-e2e/harness/commit/386bc11c08b2ddf5dd17c4164004501c8d9346d8))
* **upgrade-previous-1:** gate: true, after ten passes in a row (plan 0012 E9) ([#80](https://github.com/kanon-e2e/harness/issues/80)) ([85f06e5](https://github.com/kanon-e2e/harness/commit/85f06e5a2bde869ab9ea30a79feb273379923516))
* **upgrade-previous:** gate: true, after ten passes in a row (plan 0012 E9) ([#79](https://github.com/kanon-e2e/harness/issues/79)) ([482f902](https://github.com/kanon-e2e/harness/commit/482f902d1724626ae0a386c88c249b33b1ca741d))
* **upgrade-signal:** the weekly long-lived upgrade signal (plan 0012 E14) ([#101](https://github.com/kanon-e2e/harness/issues/101)) ([f760350](https://github.com/kanon-e2e/harness/commit/f7603506c437de6d366ea09b2b602dfc655f422a))


### Bug Fixes

* **burn-in:** a re-run counts by its first attempt (the Owner's answer of 2026-10-20, [#52](https://github.com/kanon-e2e/harness/issues/52)) ([#88](https://github.com/kanon-e2e/harness/issues/88)) ([d89b23a](https://github.com/kanon-e2e/harness/commit/d89b23a36a81d48562148499c912b4d46cee0717))
* **deploy-rehearsal:** expect the verdict job, not the deploy job, to fail on a failed smoke check ([#155](https://github.com/kanon-e2e/harness/issues/155)) ([#156](https://github.com/kanon-e2e/harness/issues/156)) ([2cc3856](https://github.com/kanon-e2e/harness/commit/2cc3856a379c52925020ac655a38d5762941708a))
* **deploy-rehearsal:** write the App register, so lane-check and the deploy gate pass ([#39](https://github.com/kanon-e2e/harness/issues/39)) ([eb5bdfe](https://github.com/kanon-e2e/harness/commit/eb5bdfe4d43a9e5f2c5ab6a40ac7cf7dc14662ef))
* **deployment.await-approval:** cancel at the wait on a candidate's run too (decision 9, amended) ([#85](https://github.com/kanon-e2e/harness/issues/85)) ([68297cc](https://github.com/kanon-e2e/harness/commit/68297cc3eb5b27461b6ae6621e2b99bc8dd8748b))
* **e2e:** break a scenario's burn-in on a run whose ledger refused it ([#114](https://github.com/kanon-e2e/harness/issues/114)) ([61a09d0](https://github.com/kanon-e2e/harness/commit/61a09d043a387a5bf031adcf068605307d428154))
* **e2e:** gate phases 2 and 3 to the scenarios that have them and haven't ended ([#63](https://github.com/kanon-e2e/harness/issues/63)) ([379c2c8](https://github.com/kanon-e2e/harness/commit/379c2c8a3c1e34f174f1d299bcfd489540ed44e5))
* **e2e:** hand every ledger refusal of a gating scenario to verdict ([#107](https://github.com/kanon-e2e/harness/issues/107)) ([#118](https://github.com/kanon-e2e/harness/issues/118)) ([abc0e71](https://github.com/kanon-e2e/harness/commit/abc0e7160a19bfb67fb088177f57d6ebfb02f91a))
* **e2e:** report reads the verdict from verdict's job outputs, not an artifact ([#24](https://github.com/kanon-e2e/harness/issues/24), item 1) ([#65](https://github.com/kanon-e2e/harness/issues/65)) ([1fb110c](https://github.com/kanon-e2e/harness/commit/1fb110c2e820495b88d857dea373e66122295297))
* **e2e:** take a scenario's result only from what an act job writes ([#110](https://github.com/kanon-e2e/harness/issues/110)) ([0d06020](https://github.com/kanon-e2e/harness/commit/0d06020560d0349a550a9eb55a66f584f1cb1d00))
* **escalation:** the guard tests, their helper and the Vitest config are the Owner's ([#127](https://github.com/kanon-e2e/harness/issues/127)) ([4881835](https://github.com/kanon-e2e/harness/commit/4881835c4d794d7a683ebb6e57a0287c2e7b27c5))
* **install:** end bootstrap before phase 2's doctor, with a new bootstrap.end verb ([#59](https://github.com/kanon-e2e/harness/issues/59)) ([#60](https://github.com/kanon-e2e/harness/issues/60)) ([064add9](https://github.com/kanon-e2e/harness/commit/064add9eab1cc5545a8901311582c6c25bfd2556))
* **plan:** check the cap against what a run plans: every gating scenario first, then the rest in rotation ([#102](https://github.com/kanon-e2e/harness/issues/102)) ([f07038c](https://github.com/kanon-e2e/harness/commit/f07038ce2b3b74ec6391085747e10c9c3635a079))
* pr.merge merges at once where the repository doesn't allow auto-merge ([#32](https://github.com/kanon-e2e/harness/issues/32)) ([1c3a937](https://github.com/kanon-e2e/harness/commit/1c3a937c8451e524d4bd8acac3eaadfc8350bc3a))
* **pr.merge:** enqueue through the front door where a merge queue sets the strategy ([#73](https://github.com/kanon-e2e/harness/issues/73)) ([#74](https://github.com/kanon-e2e/harness/issues/74)) ([fb130e5](https://github.com/kanon-e2e/harness/commit/fb130e54662042c5707301c29558685d203ac96a))
* **pr.merge:** the front door waits for a required check; a root .npmrc is the Owner's ([#140](https://github.com/kanon-e2e/harness/issues/140)) ([6c3fc5d](https://github.com/kanon-e2e/harness/commit/6c3fc5d0f0f6c441363e2eb4d12005e29ff81ba2))
* provision sets the merge settings the release's guard checks, before the first push ([#37](https://github.com/kanon-e2e/harness/issues/37)) ([f1c0cf4](https://github.com/kanon-e2e/harness/commit/f1c0cf438011c085df1d2ce40f5810e8ec0c2a0f))
* **refuse-review-label:** label only after the opened run exists, so the label's run is the one kept ([#136](https://github.com/kanon-e2e/harness/issues/136)) ([01a581f](https://github.com/kanon-e2e/harness/commit/01a581f1274983731186196121c69f158658ee8c))
* retry the runner's git calls to GitHub, and read a transport error infra ([#27](https://github.com/kanon-e2e/harness/issues/27)) ([0436b99](https://github.com/kanon-e2e/harness/commit/0436b999f824ec1f852f8297a7f19b893479ad3b))
* **retry:** ask a write GitHub never acted on once more (rate limit, never connected) ([#151](https://github.com/kanon-e2e/harness/issues/151)) ([0a0a1f4](https://github.com/kanon-e2e/harness/commit/0a0a1f46cc3ba5dad34758eb2213baae8fe1e6bf))
* **review-real:** a refused label fails first as a refusal, not at the row's deadline ([#117](https://github.com/kanon-e2e/harness/issues/117)) ([063688b](https://github.com/kanon-e2e/harness/commit/063688b66efd260c34c31585e4c7ef83647149cc))
* **runner:** a 404 inside a poll keeps the wait going to its deadline ([#19](https://github.com/kanon-e2e/harness/issues/19)) ([#116](https://github.com/kanon-e2e/harness/issues/116)) ([c94276a](https://github.com/kanon-e2e/harness/commit/c94276ab62713f93c65e5d34af99fa80fa524edd))
* **runner:** a push GitHub never delivered reads infra, not fail ([#115](https://github.com/kanon-e2e/harness/issues/115)) ([#124](https://github.com/kanon-e2e/harness/issues/124)) ([bbff10e](https://github.com/kanon-e2e/harness/commit/bbff10e56b888470e94bfc651e30f7b6a3d29cf6))
* **runner:** look up a write before asking it again; pin pr.merge's queue read; let a re-run record plan's marker ([#133](https://github.com/kanon-e2e/harness/issues/133)) ([7232509](https://github.com/kanon-e2e/harness/commit/7232509592e58c974cf23ef95cf27221000c7f64))
* **runner:** push awaits read the tree first; name a skipped review's filter; no rotation slot for a cost-less model scenario ([#132](https://github.com/kanon-e2e/harness/issues/132)) ([574eaad](https://github.com/kanon-e2e/harness/commit/574eaad8cf21a8f8ddca97df64ec34897352ede1))
* **runner:** retry gh's cut-off body and git's commit_refs failure, so they read infra ([#71](https://github.com/kanon-e2e/harness/issues/71)) ([00a59aa](https://github.com/kanon-e2e/harness/commit/00a59aaa730ee2b0321d6921acc8c02d9576d54c))
* **runner:** the validator reads its closed sets as own keys only ([#129](https://github.com/kanon-e2e/harness/issues/129)) ([#131](https://github.com/kanon-e2e/harness/issues/131)) ([4812943](https://github.com/kanon-e2e/harness/commit/48129439b2d3e700dd3285e71b6010a5eba42611))
* **validate:** refuse a pointer through display_title, body_text or body_html ([#113](https://github.com/kanon-e2e/harness/issues/113)) ([606e61d](https://github.com/kanon-e2e/harness/commit/606e61d31ee8d65c1767959f8ba1ffd85e7446b4))
* **verdict:** read the one-match layout download-artifact leaves ([#34](https://github.com/kanon-e2e/harness/issues/34)) ([af816c3](https://github.com/kanon-e2e/harness/commit/af816c349df3906844459d7db90c7512722016bc))


### Refactoring

* **runner:** one substitution module; lane-check diff both ways; deploy-rehearsal test title and README ([#135](https://github.com/kanon-e2e/harness/issues/135)) ([dbdeba3](https://github.com/kanon-e2e/harness/commit/dbdeba3cea9abbd58439d897f93b64b42cd0e00f))


### Documentation

* say only the hourly callers fired at the same instants ([#150](https://github.com/kanon-e2e/harness/issues/150)) ([79d36a2](https://github.com/kanon-e2e/harness/commit/79d36a2debb6bb29d9e3100e820a173a4bf4df74))
* **settings:** environmentReviewer's source follows decision 9's change ([#87](https://github.com/kanon-e2e/harness/issues/87)) ([6febce0](https://github.com/kanon-e2e/harness/commit/6febce0731f96ec6d0a0ae000a69379a61574b66))
* the schedules are best effort; refuse-deploy-ci-red has no default-branch ruleset ([#146](https://github.com/kanon-e2e/harness/issues/146)) ([c9c7c71](https://github.com/kanon-e2e/harness/commit/c9c7c71dd08ffab33a898c85baf48c04d72fe1e0))


### Tests

* **deploy-rehearsal:** a temporary copy that expects no open staging issue, for the mutation evidence ([#48](https://github.com/kanon-e2e/harness/issues/48)) ([e41f283](https://github.com/kanon-e2e/harness/commit/e41f283a37d4fe6e38252d68d6f3327387dccc21))
* **e12:** delete the temporary mutation copies after their dispatches ([#147](https://github.com/kanon-e2e/harness/issues/147)) ([b63f06f](https://github.com/kanon-e2e/harness/commit/b63f06ffc6a99a68610346763b2434f44b4209cf))
* **e12:** temporary mutation copies of the upgrade and doctor-broken scenarios ([#143](https://github.com/kanon-e2e/harness/issues/143)) ([76d12c4](https://github.com/kanon-e2e/harness/commit/76d12c476efe3d0c98f96a5e7054a7cc5b8d7de9))


### CI

* **deps:** run Kanon on v0.42.0, whose Merger uses the merge queue ([#159](https://github.com/kanon-e2e/harness/issues/159)) ([c5c34f7](https://github.com/kanon-e2e/harness/commit/c5c34f74d7531585aee924691f4dda354fcd5f4d))
* **probes:** retire the probe workflows; probes/README.md stays as the record ([#125](https://github.com/kanon-e2e/harness/issues/125)) ([c7a29f6](https://github.com/kanon-e2e/harness/commit/c7a29f6fdb6396e042f1371cd288aa547a3c06ae))
* send the harness's telemetry and upstream findings to Kanon, as an adopter that opts in ([#17](https://github.com/kanon-e2e/harness/issues/17)) ([1b46b24](https://github.com/kanon-e2e/harness/commit/1b46b2499a96ecc8b0c712f1e9e899190c1956db))


### Chores

* **scenarios:** remove deploy-rehearsal-mutant, its one run done ([#54](https://github.com/kanon-e2e/harness/issues/54)) ([e737124](https://github.com/kanon-e2e/harness/commit/e737124008fb4e61dd89a0d216f39448be1a6619))

## 0.1.0 (2026-10-17)


### Documentation

* **probes:** the answers E0 measured, in short, with [#968](https://github.com/kanon-e2e/harness/issues/968) as the record ([#4](https://github.com/kanon-e2e/harness/issues/4)) ([3a9f70d](https://github.com/kanon-e2e/harness/commit/3a9f70d325a6076fe549dbf3fd2cb4066afd9b09))


### CI

* finish adopting Kanon: the release lane, the escalation paths, the workflow test ([#12](https://github.com/kanon-e2e/harness/issues/12)) ([c8323f8](https://github.com/kanon-e2e/harness/commit/c8323f8cff04e11ec59444c17c46f4986a8d6a4d))
* **probes:** add E0's platform probes for plan 0012 §12 ([e06a4b2](https://github.com/kanon-e2e/harness/commit/e06a4b25d76c4747a6be8c822cc247253d13af92))
* **probes:** add E0's platform probes for plan 0012 §12 ([6516c59](https://github.com/kanon-e2e/harness/commit/6516c59c1e3a4caecc016a0490d2a18d6f515eb0))
* **probes:** probe 12's called workflow declares the driver's secrets and its caller maps them ([926e909](https://github.com/kanon-e2e/harness/commit/926e9096efc7176fd4556e57cb89c03b2e13c86b))
* **probes:** probe 12's called workflow declares the driver's secrets and its caller maps them ([e50b48f](https://github.com/kanon-e2e/harness/commit/e50b48fa7f5d1dab4defd478674fd99b98b75935))
* **probes:** probe 19 runs doctor on the kanon job's read-only token ([#6](https://github.com/kanon-e2e/harness/issues/6)) ([9b1e2ba](https://github.com/kanon-e2e/harness/commit/9b1e2bae04f3b3ce0d5834edbe6d54b215d28b7d))


### Chores

* **kanon:** adopt Kanon's full pipeline at candidate-v0.41.0 (plan 0012 E2) ([#3](https://github.com/kanon-e2e/harness/issues/3)) ([96d2dcc](https://github.com/kanon-e2e/harness/commit/96d2dcc1cbca125dd4ba01e72fc8eaef9e46ba86))
* **kanon:** bootstrap ended 2026-10-17, when the ruleset began requiring one approving review ([#5](https://github.com/kanon-e2e/harness/issues/5)) ([7eaa3a4](https://github.com/kanon-e2e/harness/commit/7eaa3a4d01c41ab0d29ededfcd305fc0c2fde02b))
