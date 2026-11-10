// `callers.fix` (#172): the upgrade skill's last edit, without the skill. It runs `kanon doctor
// --to <release> --json`, at the release under test, on the `kanon` job's clone, and applies the
// fix of each caller finding to the caller it names (`runner/lib/caller-fix.mjs`): a grant line, a
// trigger type, a secret mapping. Then it runs doctor again, and fails if a caller finding is still
// reported. It fails on a caller finding it can't apply mechanically, applying none: a release whose
// caller change doctor can't describe is the regression the gate is for. What it applied is kept.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyCallerFixes, Unfixable } from '../lib/caller-fix.mjs';
import { Fail } from '../lib/fail.mjs';
import { doctorArgs, runKanon } from '../lib/kanon.mjs';

/** The caller findings of a doctor document, as `id on subject`. @param {any} document */
const callerFindings = (document) => (Array.isArray(document?.findings) ? document.findings : [])
  .filter((/** @type {any} */ f) => typeof f?.id === 'string' && f.id.startsWith('caller.'))
  .map((/** @type {any} */ f) => `${f.id} on ${f.subject}`);

export default {
  verb: 'callers.fix',
  kind: 'kanon',
  waits: false,
  args: {},
  /** @param {any} _step @param {any} ctx */
  async run(_step, ctx) {
    const before = await runKanon(ctx, ctx.release, doctorArgs(ctx.release));
    let applied;
    try {
      applied = applyCallerFixes(
        before.document,
        (path) => readFileSync(join(ctx.clone, path), 'utf8'),
        (path, text) => writeFileSync(join(ctx.clone, path), text),
      );
    } catch (e) {
      if (e instanceof Unfixable) throw new Fail(`callers.fix: doctor --to ${ctx.release} reports a caller finding it can't apply mechanically: ${e.message}`);
      throw e;
    }
    ctx.state.callersFixed = applied;
    if (!applied.length) return;
    const after = await runKanon(ctx, ctx.release, doctorArgs(ctx.release));
    const left = callerFindings(after.document);
    if (left.length) throw new Fail(`callers.fix: after applying ${applied.length} fix(es), doctor --to ${ctx.release} still reports ${left.join(', ')}`);
  },
};
