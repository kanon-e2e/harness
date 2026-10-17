// A verb's arguments, declared so the validator can hold a step to them. Every verb's arguments
// are a closed set: a step that names one its verb doesn't take is refused, which is what keeps
// free text out of an expectation (Kanon plan 0012 §4.3).
//
// A spec is `{ type, required?, enum?, pattern?, min?, max?, items?, fields?, ref?, defines? }`:
// `ref` names the kind of thing (`prs`, `issues`, `runs`) an earlier step must have made under
// that name, and `defines` the kind this step makes under it.

/** A name a step gives what it makes, for a later step to refer to. */
export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** An App's slug. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** A finding's id, `<area>.<what>` (Kanon's docs/cli-json.md). */
export const FINDING_ID = /^[a-z0-9-]+\.[a-z0-9-]+$/;
/** A doctor check's name, as `unchecked` lists it. */
export const CHECK = /^[a-z0-9-]+$/;
/** A workflow file's name. */
export const WORKFLOW = /^[A-Za-z0-9._-]+\.ya?ml$/;
/** A branch, without a climb. */
export const BRANCH = /^(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/** @param {object} [o] */
export const str = (o = {}) => ({ type: 'string', ...o });
/** @param {object} [o] */
export const int = (o = {}) => ({ type: 'integer', ...o });
/** @param {object} [o] */
export const bool = (o = {}) => ({ type: 'boolean', ...o });
/** A list of strings, each held to `items`. @param {object} [o] */
export const strs = (o = {}) => ({ type: 'strings', ...o });
/** An object of string values. @param {object} [o] */
export const map = (o = {}) => ({ type: 'map', ...o });
/** A list of objects, each held to `fields`. @param {Record<string, any>} fields @param {object} [o] */
export const objects = (fields, o = {}) => ({ type: 'objects', fields, ...o });
/** Any JSON value, for the verb's own check to hold. @param {object} [o] */
export const json = (o = {}) => ({ type: 'json', ...o });

/** The deadline every waiting verb takes, in minutes, within the scenario's 120 (§4.1). */
export const DEADLINE = int({ required: true, min: 1, max: 120 });

/**
 * The problems of one value against its spec, each a sentence about `name`.
 * @param {string} name @param {any} spec @param {unknown} v
 * @returns {string[]}
 */
export const checkValue = (name, spec, v) => {
  const p = [];
  const item = (/** @type {string} */ what, /** @type {unknown} */ x, /** @type {any} */ s) => {
    if (typeof x !== 'string' || x === '') return `${what} must be a non-empty string`;
    if (s.enum && !s.enum.includes(x)) return `${what} must be one of ${s.enum.map((e) => `\`${e}\``).join(', ')}, not \`${x}\``;
    if (s.pattern && !s.pattern.test(x)) return `${what} \`${x}\` must match ${s.pattern}${s.hint ? ` (${s.hint})` : ''}`;
    return null;
  };
  switch (spec.type) {
    case 'string': {
      const e = item(`\`${name}\``, v, spec);
      if (e) p.push(e);
      break;
    }
    case 'integer':
      if (!Number.isInteger(v)) p.push(`\`${name}\` must be a whole number`);
      else if ((spec.min !== undefined && /** @type {number} */ (v) < spec.min) || (spec.max !== undefined && /** @type {number} */ (v) > spec.max)) {
        p.push(`\`${name}\` must be from ${spec.min} to ${spec.max}, not ${v}`);
      }
      break;
    case 'boolean':
      if (typeof v !== 'boolean') p.push(`\`${name}\` must be true or false`);
      break;
    case 'strings':
      if (!Array.isArray(v) || (spec.nonEmpty && v.length === 0)) p.push(`\`${name}\` must be a ${spec.nonEmpty ? 'non-empty ' : ''}list of strings`);
      else {
        for (const x of v) {
          const e = item(`each of \`${name}\``, x, spec.items ?? {});
          if (e) p.push(e);
        }
        if (new Set(v).size !== v.length) p.push(`\`${name}\` names something twice`);
      }
      break;
    case 'map':
      if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.values(v).some((x) => typeof x !== 'string')) p.push(`\`${name}\` must be an object of strings`);
      break;
    case 'objects':
      if (!Array.isArray(v) || v.length === 0) p.push(`\`${name}\` must be a non-empty list of objects`);
      else {
        v.forEach((o, i) => {
          if (o === null || typeof o !== 'object' || Array.isArray(o)) p.push(`\`${name}[${i}]\` must be an object`);
          else p.push(...checkArgs(spec.fields, o, `${name}[${i}].`));
        });
      }
      break;
    case 'json':
      break;
    default:
      throw new Error(`no such argument type: ${spec.type}`);
  }
  return p;
};

/**
 * The problems of an object against a spec of its keys: each missing required key, each wrong
 * value, and each key the spec doesn't name.
 * @param {Record<string, any>} specs @param {Record<string, unknown>} obj @param {string} [prefix]
 * @param {(key: string) => string} [unknown] the problem of a key the spec doesn't name
 */
export const checkArgs = (specs, obj, prefix = '', unknown = (k) => `\`${k}\` is not an argument it takes`) => {
  const p = [];
  for (const [k, s] of Object.entries(specs)) {
    if (obj[k] === undefined) {
      if (s.required) p.push(`\`${prefix}${k}\` is missing`);
    } else p.push(...checkValue(`${prefix}${k}`, s, obj[k]));
  }
  for (const k of Object.keys(obj)) if (!(k in specs)) p.push(unknown(`${prefix}${k}`));
  return p;
};
