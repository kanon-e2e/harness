// `expect.doctor` (Kanon plan 0012 §4.2, §4.3): holds the kept `kanon doctor` document to a
// status, an exit code, finding ids present and absent, other fields by pointer, and the
// `unchecked` checks allowed. Any check `unchecked` that the step doesn't list fails it, so
// "incomplete" can never pass for "healthy". On the `kanon` job's read-only token, doctor leaves
// exactly `secrets` unchecked and exits 4 (probe 19): such a scenario lists `secrets` alone. A
// `fields` entry's `equals` may hold `{{release}}`, filled in with the release under test.
// `blocking` holds the blocking findings to exactly a set of ids, read from each finding's `id`
// and `blocking` fields: a doctor-broken scenario breaks one thing, and expects that finding and
// no other blocking one (plan 0012 §6.1), whatever finding that blocks nothing doctor reports.

import { Fail } from '../lib/fail.mjs';
import { FINDING_ID, strs } from '../lib/args.mjs';
import { UNCHECKED, FIELDS_SUBSTITUTE, documentArgs, documentProblems, fieldsProblems } from '../lib/expect.mjs';
import { kept } from '../lib/state.mjs';

export default {
  verb: 'expect.doctor',
  kind: 'read',
  waits: false,
  args: {
    ...documentArgs(['healthy', 'findings', 'incomplete', 'error']),
    unchecked: UNCHECKED,
    blocking: strs({ items: { pattern: FINDING_ID, hint: 'a finding id' } }),
  },
  check: (/** @type {any} */ step) => fieldsProblems(step.fields),
  substitutes: FIELDS_SUBSTITUTE,
  uses: () => [['documents', 'doctor']],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const doc = kept(ctx, 'doctor');
    const problems = [...documentProblems(doc, step, step.unchecked ?? [], ctx.release), ...blockingProblems(doc.document, step.blocking)];
    if (problems.length) throw new Fail(`kanon doctor: ${problems.join('; ')}`);
  },
};

/**
 * The problems of the document's blocking findings against `blocking`, the exact set of ids
 * expected to block: a blocking finding not listed fails it, and so does a listed id that
 * doesn't block. Without `blocking`, nothing.
 * @param {any} doc @param {string[] | undefined} expected
 */
export const blockingProblems = (doc, expected) => {
  if (expected === undefined) return [];
  const read = [...new Set((doc.findings ?? []).filter((/** @type {any} */ f) => f.blocking === true).map((/** @type {any} */ f) => f.id))];
  return [
    ...read.filter((id) => !expected.includes(id)).map((id) => `finding \`${id}\` blocks, and the scenario expects no blocking finding but ${expected.map((x) => `\`${x}\``).join(', ') || 'none'}`),
    ...expected.filter((id) => !read.includes(id)).map((id) => `finding \`${id}\`: expected blocking, ${(doc.findings ?? []).some((/** @type {any} */ f) => f.id === id) ? 'reported as not blocking' : 'not reported'}`),
  ];
};
