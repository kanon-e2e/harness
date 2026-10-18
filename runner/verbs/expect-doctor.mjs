// `expect.doctor` (Kanon plan 0012 §4.2, §4.3): holds the kept `kanon doctor` document to a
// status, an exit code, finding ids present and absent, other fields by pointer, and the
// `unchecked` checks allowed. Any check `unchecked` that the step doesn't list fails it, so
// "incomplete" can never pass for "healthy". On the `kanon` job's read-only token, doctor leaves
// exactly `secrets` unchecked and exits 4 (probe 19): such a scenario lists `secrets` alone. A
// `fields` entry's `equals` may hold `{{release}}`, filled in with the release under test.

import { Fail } from '../lib/fail.mjs';
import { UNCHECKED, FIELDS_SUBSTITUTE, documentArgs, documentProblems, fieldsProblems } from '../lib/expect.mjs';
import { kept } from '../lib/state.mjs';

export default {
  verb: 'expect.doctor',
  kind: 'read',
  waits: false,
  args: { ...documentArgs(['healthy', 'findings', 'incomplete', 'error']), unchecked: UNCHECKED },
  check: (/** @type {any} */ step) => fieldsProblems(step.fields),
  substitutes: FIELDS_SUBSTITUTE,
  uses: () => [['documents', 'doctor']],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const problems = documentProblems(kept(ctx, 'doctor'), step, step.unchecked ?? [], ctx.release);
    if (problems.length) throw new Fail(`kanon doctor: ${problems.join('; ')}`);
  },
};
