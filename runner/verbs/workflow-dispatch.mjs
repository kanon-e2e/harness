// `workflow.dispatch` (Kanon plan 0012 §4.2): dispatches a workflow of the scenario repository,
// such as `apps-check` before doctor, on the default branch unless `ref` says otherwise.

import { BRANCH, WORKFLOW, map, str } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';

export default {
  verb: 'workflow.dispatch',
  kind: 'act',
  waits: false,
  args: {
    workflow: str({ required: true, pattern: WORKFLOW }),
    ref: str({ pattern: BRANCH }),
    inputs: map(),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    await api(ctx, repoPath(ctx, `actions/workflows/${step.workflow}/dispatches`), { method: 'POST', body: { ref: step.ref ?? ctx.defaultBranch, inputs: step.inputs ?? {} } });
  },
};
