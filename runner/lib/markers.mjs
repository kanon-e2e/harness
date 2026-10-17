// The harness's list of known markers (Kanon plan 0012 §4.3), read from runner/known-markers.json.

import { readFileSync } from 'node:fs';

/** @type {Array<{ id: string, pattern: string, writtenBy: string }>} */
export const KNOWN_MARKERS = JSON.parse(readFileSync(new URL('../known-markers.json', import.meta.url), 'utf8')).markers;

/** The marker's regular expression, or null when the id isn't on the list. @param {string} id */
export const markerById = (id) => {
  const m = KNOWN_MARKERS.find((x) => x.id === id);
  return m ? new RegExp(m.pattern) : null;
};
