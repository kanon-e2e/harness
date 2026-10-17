// `pins.move` (Kanon plan 0012 §4.2): runs Kanon's `scripts/move-pins.mjs` (plan 0009 S4), at the
// release under test, on the `kanon` job's clone, to that release: the upgrade skill's edit,
// without the skill. The files it moved are kept, for the record.

import { join } from 'node:path';

import { kanonRoot } from '../lib/kanon.mjs';

export default {
  verb: 'pins.move',
  kind: 'kanon',
  waits: false,
  args: {},
  /** @param {any} _step @param {any} ctx */
  async run(_step, ctx) {
    const root = await kanonRoot(ctx, ctx.release);
    const r = await ctx.exec('node', [join(root, 'scripts/move-pins.mjs'), ctx.release, '--root', ctx.clone], { cwd: ctx.clone });
    if (r.status !== 0) throw new Error(`move-pins.mjs failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim()}`);
    ctx.state.moved = String(r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  },
};
