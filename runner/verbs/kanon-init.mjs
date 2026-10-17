// `kanon.init` (Kanon plan 0012 §4.2): runs `kanon init --json --yes --no-apps` with the
// scenario's flags against the `kanon` job's clone of the scenario repository, at the release
// under test, with telemetry and sharing declined (decision 8). The CLI writes only to the clone;
// the next `act` job pushes it. The document is kept for `expect.init` and `repo.apply`.

import { strs } from '../lib/args.mjs';
import { initArgs, initFlagProblems, keep, runKanon } from '../lib/kanon.mjs';

export default {
  verb: 'kanon.init',
  kind: 'kanon',
  waits: false,
  args: { flags: strs() },
  check: (/** @type {any} */ step) => initFlagProblems(step.flags),
  defines: () => [['documents', 'init']],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    keep(ctx, 'init', await runKanon(ctx, ctx.release, initArgs(step.flags)));
  },
};
