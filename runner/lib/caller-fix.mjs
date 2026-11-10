// What `callers.fix` applies (#172): the fix of each caller finding `kanon doctor --to <release>`
// reports, written into the caller file it names, as the upgrade skill does. An upgrade by
// `pins.move` and `kanon.init` alone leaves every caller as the older release wrote it, because
// `init` never rewrites a caller that exists; so a release that changes what a caller must grant,
// map or subscribe to fails `Lane check` on the upgrade, though an adopter's documented upgrade
// passes.
//
// MECHANICAL ONLY. Each fix doctor writes for these findings is the YAML to add or remove, with
// the indentation of the caller `kanon init` writes, so it is applied as text, line by line, at
// the place the caller's layout gives it. No YAML parser: the runner runs with Node's built-ins
// alone. A finding with any other id, or one whose fix doesn't fit the caller as written (a
// permissions block that isn't a map, a job-level grant, an event whose types aren't a one-line
// list, two events the types could belong to), is refused by name, and the scenario fails: a
// release whose caller change doctor can't describe mechanically is the regression the gate is for.
//
//   caller.grant-missing          `  <permission>: <level>` lines: set each under the top-level
//                                 `permissions:`, replacing a weaker level or adding the line.
//   caller.event-types-missing    `  <event>:` and `    types: [...]` (an event the caller doesn't
//                                 take): add both at the end of `on:`. `    types: [...]` alone (a
//                                 type missing): replace the `types:` of the one event whose list
//                                 the new one extends.
//   caller.workflow-run-missing   `  workflow_run:`, `    workflows: [...]`, `    types: [...]`:
//                                 add them at the end of `on:`. `    workflows: [...]` alone:
//                                 replace the `workflow_run`'s `workflows:` line.
//   caller.secret-missing         `      <NAME>: ${{ secrets.<NAME> }}` lines: add each, not
//                                 already there, at the end of the job's `secrets:`.
//   caller.secret-stale           the same lines: remove each from the job's `secrets:`.

/** The caller findings `callers.fix` applies. */
export const FIXABLE = Object.freeze(['caller.grant-missing', 'caller.event-types-missing', 'caller.workflow-run-missing', 'caller.secret-missing', 'caller.secret-stale']);

/** A caller file the fix can't be applied to as written: the scenario fails, naming why. */
export class Unfixable extends Error {}

const indentOf = (/** @type {string} */ l) => l.length - l.trimStart().length;
const isContent = (/** @type {string} */ l) => l.trim() !== '' && !l.trimStart().startsWith('#');
const KEY = (/** @type {string} */ k) => new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(?:\\s+(.*?))?\\s*$`);

/**
 * The lines a block holds: from the line after `at` to the last content line indented deeper than
 * it. `[start, end)`, where `end` is just past its last content line.
 * @param {string[]} lines @param {number} at
 */
export const blockOf = (lines, at) => {
  const indent = indentOf(lines[at]);
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i++) {
    if (!isContent(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) break;
    end = i + 1;
  }
  return { start: at + 1, end };
};

/**
 * Where `key:` sits at `indent` spaces, within `[from, to)`, or -1.
 * @param {string[]} lines @param {string} key @param {number} indent @param {number} [from] @param {number} [to]
 */
export const keyAt = (lines, key, indent, from = 0, to = lines.length) => {
  for (let i = from; i < to; i++) {
    if (isContent(lines[i]) && indentOf(lines[i]) === indent && KEY(key).test(lines[i].trimStart())) return i;
  }
  return -1;
};

/** The items of a one-line flow list, `[a, b]`, or null. @param {string} value */
const flowList = (value) => {
  const m = /^\[(.*)\]$/.exec(value.trim());
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
};

/** The calling job's `secrets:` line: the one job that has one. @param {string[]} lines */
const secretsBlock = (lines) => {
  const jobs = keyAt(lines, 'jobs', 0);
  if (jobs === -1) throw new Unfixable('it has no jobs:');
  const { start, end } = blockOf(lines, jobs);
  const found = [];
  for (let i = start; i < end; i++) if (isContent(lines[i]) && indentOf(lines[i]) === 4 && /^secrets:\s*$/.test(lines[i].trimStart())) found.push(i);
  if (found.length !== 1) throw new Unfixable(`it has ${found.length} job-level secrets: blocks, not one`);
  return found[0];
};

/** The top-level `on:` line. @param {string[]} lines */
const onBlock = (lines) => {
  const at = keyAt(lines, 'on', 0);
  if (at === -1 || (lines[at].trim() !== 'on:')) throw new Unfixable('its on: is not a block of events');
  return at;
};

/** Adds an event's lines at the end of `on:`. @param {string[]} lines @param {string[]} add */
const addEvent = (lines, add) => {
  const on = onBlock(lines);
  const event = /^ {2}([a-z_]+):$/.exec(add[0])?.[1];
  if (!event || add.slice(1).some((l) => indentOf(l) !== 4)) throw new Unfixable(`the fix's lines are not one event under on: (${add.join(' / ')})`);
  const { start, end } = blockOf(lines, on);
  if (keyAt(lines, event, 2, start, end) !== -1) throw new Unfixable(`it takes ${event} already, and the fix adds it whole`);
  lines.splice(end, 0, ...add);
};

/**
 * Applies one finding's fix to a caller's text, and returns the new text.
 * @param {string} text the caller file
 * @param {{ id: string, subject?: string, fix?: { text?: string, commands?: string[] } }} finding
 * @returns {string}
 */
export function applyFix(text, finding) {
  if (!FIXABLE.includes(finding.id)) throw new Unfixable(`${finding.id} is not a fix callers.fix applies`);
  const commands = finding.fix?.commands ?? [];
  if (!commands.length) throw new Unfixable(`${finding.id} carries no lines to apply`);
  const lines = text.split('\n');

  if (finding.id === 'caller.grant-missing') {
    // A permissions: that isn't a map is replaced whole; doctor's fix starts `permissions:` then.
    if (commands[0] === 'permissions:') throw new Unfixable('its permissions: is not a map of grants');
    if (lines.some((l) => indentOf(l) === 4 && /^permissions:/.test(l.trimStart()))) throw new Unfixable('it grants at the job level, and the fix is for the top-level permissions:');
    const at = keyAt(lines, 'permissions', 0);
    if (at === -1 || lines[at].trim() !== 'permissions:') throw new Unfixable('it has no top-level permissions: map');
    for (const c of commands) {
      const m = /^ {2}([a-z-]+): (read|write)$/.exec(c);
      if (!m) throw new Unfixable(`the grant line \`${c.trim()}\` is not \`<permission>: <level>\``);
      const { start, end } = blockOf(lines, at);
      const have = keyAt(lines, m[1], 2, start, end);
      if (have !== -1) lines[have] = c;
      else lines.splice(end, 0, c);
    }
    return lines.join('\n');
  }

  if (finding.id === 'caller.event-types-missing' || finding.id === 'caller.workflow-run-missing') {
    if (indentOf(commands[0]) === 2) {
      addEvent(lines, commands);
      return lines.join('\n');
    }
    if (commands.length !== 1) throw new Unfixable(`the fix's lines are not one list to replace (${commands.join(' / ')})`);
    const m = /^ {4}(types|workflows): (\[.*\])$/.exec(commands[0]);
    const want = m && flowList(m[2]);
    if (!m || !want) throw new Unfixable(`the line \`${commands[0].trim()}\` is not a types: or workflows: list`);
    const field = m[1];
    const on = onBlock(lines);
    const { start, end } = blockOf(lines, on);
    // The event whose list the new one extends: for workflows:, the workflow_run; for types:,
    // the one event whose types are all in the new list, which has more.
    const targets = [];
    for (let i = start; i < end; i++) {
      if (!isContent(lines[i]) || indentOf(lines[i]) !== 2) continue;
      const name = lines[i].trim().replace(/:.*$/, '');
      if (field === 'workflows' && name !== 'workflow_run') continue;
      const ev = blockOf(lines, i);
      const line = keyAt(lines, field, 4, ev.start, ev.end);
      if (line === -1) continue;
      const have = flowList(lines[line].trimStart().slice(field.length + 1));
      if (!have) throw new Unfixable(`the ${name} ${field}: is not a one-line list`);
      if (have.every((x) => want.includes(x)) && want.length > have.length) targets.push(line);
    }
    if (targets.length !== 1) throw new Unfixable(`${targets.length} events' ${field}: the new list \`${m[2]}\` extends, not one`);
    lines[targets[0]] = commands[0];
    return lines.join('\n');
  }

  // caller.secret-missing and caller.secret-stale: lines under the calling job's secrets:.
  const at = secretsBlock(lines);
  for (const c of commands) {
    if (!/^ {6}[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/.test(c)) throw new Unfixable(`the secret line \`${c.trim()}\` is not \`<NAME>: \${{ secrets.<NAME> }}\``);
    const { start, end } = blockOf(lines, at);
    const i = lines.slice(start, end).findIndex((l) => l.trimEnd() === c);
    if (finding.id === 'caller.secret-missing') {
      if (i === -1) lines.splice(end, 0, c);
    } else {
      if (i === -1) throw new Unfixable(`it doesn't map \`${c.trim()}\`, which the fix removes`);
      lines.splice(start + i, 1);
    }
  }
  return lines.join('\n');
}

/**
 * Applies every caller finding of a doctor document to the files in `read`/`write`, in order.
 * Returns what it applied; throws `Unfixable` naming every finding it couldn't, applying none.
 * @param {any} document `kanon doctor --json`'s document
 * @param {(path: string) => string} read @param {(path: string, text: string) => void} write
 * @returns {Array<{ id: string, subject: string }>}
 */
export function applyCallerFixes(document, read, write) {
  const findings = (Array.isArray(document?.findings) ? document.findings : []).filter((f) => typeof f?.id === 'string' && f.id.startsWith('caller.'));
  /** @type {Map<string, string>} */
  const texts = new Map();
  const refused = [];
  for (const f of findings) {
    const subject = String(f.subject ?? '');
    try {
      if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(subject)) throw new Unfixable(`its subject \`${subject}\` is not a workflow file`);
      texts.set(subject, applyFix(texts.get(subject) ?? read(subject), f));
    } catch (e) {
      if (!(e instanceof Unfixable)) throw e;
      refused.push(`${f.id} on ${subject || 'no file'}: ${e.message}`);
    }
  }
  if (refused.length) throw new Unfixable(refused.join('; '));
  for (const [path, text] of texts) write(path, text);
  return findings.map((f) => ({ id: f.id, subject: f.subject }));
}
