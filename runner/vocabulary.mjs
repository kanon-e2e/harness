// The step vocabulary (Kanon plan 0012 §4.2): a closed set, each verb implemented once, in
// runner/verbs/<verb>.mjs. A scenario that needs another verb adds it in a pull request, with its
// test, and runner/ is the Owner's to merge (docs/qa/escalation-paths.md).
//
// A verb module's default export:
//   verb     its name, as steps.json writes it;
//   kind     `kanon` (runs Kanon's code: kanon segments only), `act` (writes to GitHub with the
//            harness's code: act segments only) or `read` (only reads: either segment);
//   waits    whether it waits, and so takes a `deadline` in minutes and polls (§10);
//   args     its arguments, a closed set (lib/args.mjs), `deadline` aside;
//   check    optional: the problems of a step beyond its arguments' types, for the validator;
//   defines, uses   optional: what it keeps in, or reads from, the run's state, for the validator;
//   run(step, ctx)  does it. A false expectation, or a deadline passed, throws `Fail`.
//
// The context the runner hands a verb (E4): `repository` (`<owner>/<name>`), `release` (the
// release under test), `harness` (this repository), `trigger` (`nightly`, `candidate` or
// `dispatch`), `defaultBranch`, `scenario` (its scenario.json), `scenarioDir`, `clone` (the job's
// own clone of the scenario repository), `kanonFiles` (in an act job: the kanon job's files,
// already taken as data), `state` (the run's state, JSON), `gh(args, input)` and `exec(cmd, args,
// { cwd })`, each resolving to `{ status, stdout, stderr }`, and `now()` and `sleep(ms)`.

import deploymentAwaitApproval from './verbs/deployment-await-approval.mjs';
import environmentCreate from './verbs/environment-create.mjs';
import expectApi from './verbs/expect-api.mjs';
import expectArtifact from './verbs/expect-artifact.mjs';
import expectCheck from './verbs/expect-check.mjs';
import expectDoctor from './verbs/expect-doctor.mjs';
import expectInit from './verbs/expect-init.mjs';
import expectIssue from './verbs/expect-issue.mjs';
import expectPr from './verbs/expect-pr.mjs';
import expectRun from './verbs/expect-run.mjs';
import filesCommit from './verbs/files-commit.mjs';
import issueAwait from './verbs/issue-await.mjs';
import issueLabel from './verbs/issue-label.mjs';
import issueOpen from './verbs/issue-open.mjs';
import kanonAt from './verbs/kanon-at.mjs';
import kanonDoctor from './verbs/kanon-doctor.mjs';
import kanonInit from './verbs/kanon-init.mjs';
import pinsMove from './verbs/pins-move.mjs';
import prLabel from './verbs/pr-label.mjs';
import prMerge from './verbs/pr-merge.mjs';
import prOpen from './verbs/pr-open.mjs';
import registerWrite from './verbs/register-write.mjs';
import releaseCut from './verbs/release-cut.mjs';
import repoApply from './verbs/repo-apply.mjs';
import rulesetTags from './verbs/ruleset-tags.mjs';
import runAwait from './verbs/run-await.mjs';
import workflowDispatch from './verbs/workflow-dispatch.mjs';

const ALL = [
  kanonInit, repoApply, kanonDoctor, kanonAt, registerWrite, pinsMove, filesCommit,
  prOpen, prLabel, prMerge, issueOpen, issueLabel, workflowDispatch, releaseCut,
  deploymentAwaitApproval, runAwait, expectInit, expectDoctor, expectRun, expectCheck,
  expectIssue, expectPr, expectArtifact, expectApi,
  environmentCreate, rulesetTags, issueAwait,
];

/** Every verb, by name. @type {Readonly<Record<string, any>>} */
export const VOCABULARY = Object.freeze(Object.fromEntries(ALL.map((v) => [v.verb, v])));
if (Object.keys(VOCABULARY).length !== ALL.length) throw new Error('a verb is implemented twice');
