// `register.write` (Kanon plan 0012 §4.2, §5.2): writes the App register's rows for the
// scenario's test Apps into the `kanon` job's clone, through the library `kanon apps` writes them
// with (`cli/app-register.mjs`), at the release under test, with each App's roles and
// permissions from that release's requirements.json. It holds no key: the Apps' secrets are
// `provision`'s to write.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { kanonRoot } from '../lib/kanon.mjs';

const REGISTER = 'docs/qa/agent-identities.md';
/** @type {Record<string, string>} */
const SLUGS = JSON.parse(readFileSync(new URL('../test-apps.json', import.meta.url), 'utf8')).apps;

export default {
  verb: 'register.write',
  kind: 'kanon',
  waits: false,
  args: {},
  /** @param {any} _step @param {any} ctx */
  async run(_step, ctx) {
    const root = await kanonRoot(ctx, ctx.release);
    const { writeRegisterRow } = await import(pathToFileURL(join(root, 'cli/app-register.mjs')).href);
    const { identities } = JSON.parse(readFileSync(join(root, 'requirements.json'), 'utf8'));
    const path = join(ctx.clone, REGISTER);
    /** @type {string | null} */
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    for (const app of ctx.scenario.apps) {
      const spec = identities.apps?.[app];
      const slug = SLUGS[app];
      if (!spec || !slug) throw new Error(`the App \`${app}\` is not one Kanon ${ctx.release} or the harness knows`);
      for (const role of spec.roles) {
        const name = identities.roles?.[role]?.name ?? role.charAt(0).toUpperCase() + role.slice(1);
        text = writeRegisterRow(text, { role: name, slug, permissions: spec.permissions }).text;
      }
    }
    if (text === null) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
};
