// `expect.api` (Kanon plan 0012 §4.2): makes one GET of the scenario repository's own API, a path
// under `repos/{{repository}}/`, and holds the JSON value at a pointer to a value. It polls,
// one GET per try, until the value holds or its deadline passes. The validator refuses any other
// path, and so does the verb before it calls anything.

import { json, str } from '../lib/args.mjs';
import { equalsProblems, pointerProblems } from '../lib/expect.mjs';
import { api } from '../lib/gh.mjs';
import { at, same } from '../lib/pointer.mjs';
import { met, poll, unmet } from '../lib/poll.mjs';
import { differs } from '../lib/state.mjs';

export const PREFIX = 'repos/{{repository}}/';
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const QUERY = /^[A-Za-z0-9._~=&,%+-]*$/;
const REFUSED = `\`expect.api\` reads only the scenario repository's own API: its path is \`${PREFIX}\` and what follows, without a climb, an encoded or empty segment`;

/** The problem with a path, or null. @param {unknown} path */
export const pathProblem = (path) => {
  if (typeof path !== 'string' || !path.startsWith(PREFIX)) return REFUSED;
  const [rest, query, ...more] = path.slice(PREFIX.length).split('?');
  if (more.length || (query !== undefined && !QUERY.test(query))) return REFUSED;
  if (rest === '') return null;
  return rest.split('/').every((s) => SEGMENT.test(s) && s !== '.' && s !== '..') ? null : REFUSED;
};

/** The REST path for the scenario repository. @param {string} path @param {string} repository */
export const resolve = (path, repository) => {
  const problem = pathProblem(path);
  if (problem) throw new Error(problem);
  const rest = path.slice(PREFIX.length);
  return `repos/${repository}${rest === '' ? '' : rest.startsWith('?') ? rest : `/${rest}`}`;
};

export default {
  verb: 'expect.api',
  kind: 'read',
  waits: true,
  args: {
    path: str({ required: true }),
    pointer: str({ required: true }),
    equals: json({ required: true }),
  },
  check: (/** @type {any} */ step) => [...(pathProblem(step.path) ? [/** @type {string} */ (pathProblem(step.path))] : []), ...pointerProblems(step.pointer), ...equalsProblems(step.equals)],
  /** The one place a substitution may sit in steps.json. */
  substitutes: { path: ['repository'] },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const path = resolve(step.path, ctx.repository);
    await poll(ctx, step.deadline, async () => {
      const v = at(await api(ctx, path), step.pointer);
      if (!v.found) return unmet(`\`${step.pointer}\`: not in the answer of GET ${path}`);
      return same(v.value, step.equals) ? met() : unmet(/** @type {string} */ (differs(`\`${step.pointer}\``, step.equals, v.value)));
    });
  },
};
