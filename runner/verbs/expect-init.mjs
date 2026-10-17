// `expect.init` (Kanon plan 0012 §4.2, §4.3): holds the kept `kanon init` document to a status,
// an exit code, finding ids present and absent, and other fields by pointer. It reads a
// finding's id, never its message.

import { Fail } from '../lib/fail.mjs';
import { documentArgs, documentProblems, fieldsProblems } from '../lib/expect.mjs';
import { kept } from '../lib/state.mjs';

export default {
  verb: 'expect.init',
  kind: 'read',
  waits: false,
  args: documentArgs(['complete', 'steps-left', 'failed', 'error']),
  check: (/** @type {any} */ step) => fieldsProblems(step.fields),
  uses: () => [['documents', 'init']],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const problems = documentProblems(kept(ctx, 'init'), step, null);
    if (problems.length) throw new Fail(`kanon init: ${problems.join('; ')}`);
  },
};
