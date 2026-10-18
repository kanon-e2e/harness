// What every expectation shares (Kanon plan 0012 §4.3): it names only a JSON field (by name or
// pointer), a finding id or a known marker, and compares it to a value. The arguments below are
// the only ones an expectation of a kept document takes, and the checks the validator runs on
// any pointer and marker.

import { CHECK, FINDING_ID, SLUG, json, objects, str, strs } from './args.mjs';
import { markerById } from './markers.mjs';
import { at, comparable, freeTextField, same, tokens } from './pointer.mjs';
import { differs } from './state.mjs';

/** `fields`: other fields of the document, each by pointer, to a value. */
export const FIELDS = objects({ pointer: str({ required: true }), equals: json({ required: true }) });

/** Where `expect.init` and `expect.doctor` take a substitution: `{{release}}` in a `fields` entry's `equals`. */
export const FIELDS_SUBSTITUTE = Object.freeze({ 'fields.equals': ['release'] });

/** An expected value with `{{release}}` filled in, in a string or in a list of them. @param {unknown} v @param {string} release */
export const withRelease = (v, release) => (typeof v === 'string' ? v.replaceAll('{{release}}', release) : Array.isArray(v) ? v.map((x) => withRelease(x, release)) : v);

/** The arguments `expect.init` and `expect.doctor` share. @param {string[]} statuses */
export const documentArgs = (statuses) => ({
  status: str({ enum: statuses }),
  exitCode: { type: 'integer', min: 0, max: 255 },
  findings: strs({ items: { pattern: FINDING_ID, hint: 'a finding id' } }),
  absent: strs({ items: { pattern: FINDING_ID, hint: 'a finding id' } }),
  fields: FIELDS,
});

/** The problems of a pointer an expectation reads: not a pointer, or one through free text. @param {unknown} pointer */
export const pointerProblems = (pointer) => {
  if (!tokens(pointer)) return [`\`${pointer}\` is not a JSON pointer to a field (one starts with \`/\`)`];
  const field = freeTextField(/** @type {string} */ (pointer));
  return field ? [`\`${pointer}\` reads \`${field}\`, a field that holds free text: an expectation reads only fields, finding ids and known markers, never prose`] : [];
};

/** The problems of the value an expectation holds a field to. @param {unknown} v */
export const equalsProblems = (v) => (comparable(v) ? [] : ['`equals` must be a string, a number, a boolean, null, or a list of them: an object could carry free text']);

/** The problems of each `fields` entry. @param {unknown} fields */
export const fieldsProblems = (fields) => (Array.isArray(fields) ? fields.flatMap((f) => (f && typeof f === 'object' ? [...pointerProblems(f.pointer), ...equalsProblems(f.equals)] : [])) : []);

/** The problems of a marker id: one not on the harness's list. @param {unknown} id */
export const markerProblems = (id) => (id === undefined || (typeof id === 'string' && markerById(id)) ? [] : [`\`${id}\` is not a known marker: runner/known-markers.json lists the markers Kanon already writes`]);

/** An App's slug, as an expectation names an author. */
export const AUTHOR = str({ pattern: SLUG, hint: 'an App\'s slug' });

/** The `unchecked` checks `expect.doctor` allows. */
export const UNCHECKED = strs({ items: { pattern: CHECK, hint: 'a doctor check\'s name' } });

/**
 * The problems of a kept document against an expectation. With `allowed` (doctor's), every
 * `unchecked` check the scenario doesn't list fails it, so "incomplete" never passes for "healthy".
 * A `fields` entry's `equals` has `{{release}}` filled in with `release`, the release under test.
 * @param {{ exit: number, document: any }} kept @param {any} step @param {string[] | null} allowed @param {string} release
 */
export const documentProblems = ({ exit, document: doc }, step, allowed, release) => {
  const p = [];
  if (step.status !== undefined) p.push(differs('status', step.status, doc.status));
  if (step.exitCode !== undefined && (exit !== step.exitCode || doc.exitCode !== step.exitCode)) {
    p.push(`exit code: expected ${step.exitCode}, read ${exit} (the document says ${doc.exitCode})`);
  }
  const ids = (doc.findings ?? []).map((/** @type {any} */ f) => f.id);
  for (const id of step.findings ?? []) if (!ids.includes(id)) p.push(`finding \`${id}\`: not reported`);
  for (const id of step.absent ?? []) if (ids.includes(id)) p.push(`finding \`${id}\`: reported`);
  for (const { pointer, equals: expected } of step.fields ?? []) {
    const equals = withRelease(expected, release);
    const v = at(doc, pointer);
    p.push(v.found ? (same(v.value, equals) ? null : differs(`\`${pointer}\``, equals, v.value)) : `\`${pointer}\`: not in the document`);
  }
  if (allowed) {
    for (const u of doc.unchecked ?? []) if (!allowed.includes(u.check)) p.push(`unchecked: \`${u.check}\`, which the scenario doesn't list as allowed`);
  }
  return /** @type {string[]} */ (p.filter(Boolean));
};
