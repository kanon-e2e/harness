// JSON pointers (RFC 6901), and the expectation rule's half about fields (Kanon plan 0012 §4.3):
// an expectation may name a JSON field, but never one that holds free text.

/**
 * The fields that hold free text, in Kanon's JSON (`docs/cli-json.md`: a finding's `message` and
 * its `fix`, doctor's `checking`, `notes` and an unchecked check's `reason`, init's `summary`,
 * `failures`, a file's `content` and `diff`, the catalogue's `does`, the error document's `error`)
 * and in GitHub's (a comment's or a pull request's `body`, and its `body_text` and `body_html`, a
 * title, and a workflow run's `display_title`, filled from a commit's message or a pull request's
 * title, a description, a commit's `message`, a check run's `output`). A pointer through any of them
 * is refused, whatever follows.
 */
export const FREE_TEXT_FIELDS = Object.freeze([
  'body', 'body_html', 'body_text', 'checking', 'comment', 'content', 'description', 'details', 'diff',
  'display_title', 'does', 'error', 'failures', 'fix', 'log', 'message', 'notes', 'output', 'prose',
  'reason', 'summary', 'text', 'title',
]);

/** The pointer's tokens, or null when it isn't one. A pointer to the whole document isn't taken. @param {unknown} pointer */
export const tokens = (pointer) => {
  if (typeof pointer !== 'string' || !/^\//.test(pointer)) return null;
  return pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
};

/** The free-text field a pointer reads, or null. @param {string} pointer */
export const freeTextField = (pointer) => (tokens(pointer) ?? []).find((t) => FREE_TEXT_FIELDS.includes(t)) ?? null;

/** The value at a pointer: `{ found, value }`. @param {any} doc @param {string} pointer */
export const at = (doc, pointer) => {
  let here = doc;
  for (const t of tokens(pointer) ?? []) {
    if (here === null || typeof here !== 'object' || !Object.prototype.hasOwnProperty.call(here, t)) return { found: false, value: undefined };
    here = here[t];
  }
  return { found: true, value: here };
};

/** Whether an expected value is one an expectation may hold a field to: a scalar, or a list of them. @param {unknown} v */
export const comparable = (v) => {
  const scalar = (/** @type {unknown} */ x) => x === null || ['string', 'number', 'boolean'].includes(typeof x);
  return scalar(v) || (Array.isArray(v) && v.every(scalar));
};

/** Equality of two comparable values. @param {unknown} a @param {unknown} b */
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
