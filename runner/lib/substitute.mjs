// The two substitutions a scenario's files take (Kanon plan 0012 §4.1): `{{release}}`, the
// release under test, and `{{repository}}`, the scenario repository's `<owner>/<name>`. `start/`
// takes them (the runner's `layStart`, the validator's `validateStart`), and so does a directory
// `files.commit` commits `from: scenario`, so a file committed after the install can pin the
// release under test, as every Kanon reference must (harness E12, the `lane-check` family). A
// workflow's `${{ expression }}` is not a substitution, and a binary file (one with a NUL byte) is
// left as it is.

/** The two substitutions. */
export const SUBSTITUTIONS = Object.freeze(['release', 'repository']);
/** `{{name}}`, but not a workflow's `${{ expression }}`. */
export const SUBSTITUTION = /(?<!\$)\{\{([^{}]*)\}\}/g;

/** The substitutions in `text` that aren't the two. @param {string} text */
export const strangers = (text) => [...text.matchAll(SUBSTITUTION)].map((m) => m[0]).filter((m) => !SUBSTITUTIONS.includes(m.slice(2, -2)));

/** `text` with `{{release}}` and `{{repository}}` filled in. @param {string} text @param {Record<string, string>} values */
export const substitute = (text, values) => text.replace(SUBSTITUTION, (m, name) => (SUBSTITUTIONS.includes(name) ? values[name] : m));

/** A file's bytes with the two filled in, or as they are when it is binary. @param {Buffer} bytes @param {Record<string, string>} values */
export const substituteBytes = (bytes, values) => (bytes.includes(0) ? bytes : Buffer.from(substitute(bytes.toString('utf8'), values), 'utf8'));
