// `kanon.doctor` (Kanon plan 0012 §4.2): runs `kanon doctor --json`, with `to`, `--to` the
// release under test, from the `kanon` job's clone of the default branch, at the release under
// test, and keeps the document and its exit code for `expect.doctor`.

import { bool } from '../lib/args.mjs';
import { doctorArgs, keep, runKanon } from '../lib/kanon.mjs';

export default {
  verb: 'kanon.doctor',
  kind: 'kanon',
  waits: false,
  args: { to: bool() },
  defines: () => [['documents', 'doctor']],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    keep(ctx, 'doctor', await runKanon(ctx, ctx.release, doctorArgs(step.to ? ctx.release : null)));
  },
};
