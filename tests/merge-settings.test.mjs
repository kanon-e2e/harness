import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MERGE_SETTINGS } from '../runner/lib/adopt.mjs';
import { tempDir } from './helpers/stubs.mjs';
import { readWorkflows } from './helpers/workflows.mjs';

/**
 * `provision` sets K-ADOPT-1 step 5's merge settings before anything reaches the default branch
 * (harness #36): `kanon init`'s read-only token can't see them, so it names no `merge.settings`
 * for `repo.apply`, and Kanon's release.yml stops at its merge-settings guard (K-SHIP-3) on the
 * first push, which lays `start/`. The values are the ones the release under test's guard checks,
 * read from its release.yml as data, so the harness holds no copy of them.
 */

const provision = readWorkflows()['e2e.yml'].jobs.provision;
const NAME = 'Set the merge settings the release\'s guard checks (K-ADOPT-1 step 5)';
const step = provision.steps.find((s) => s.name === NAME);
const RELEASE = 'candidate-v9.9.9';

/** Kanon's guard step as its release.yml writes it, with `expected` as given. @param {Record<string, unknown>} expected */
const guardYml = (expected) => [
  'jobs:',
  '  release:',
  '    steps:',
  '      - name: Check the merge settings (K-SHIP-3)',
  '        id: merge-settings',
  '        run: |',
  '          const repo = process.env.GITHUB_REPOSITORY;',
  '          const expected = {',
  ...Object.entries(expected).map(([k, v]) => `            ${k}: ${typeof v === 'string' ? `'${v}'` : v},`),
  '          };',
  '          const wrong = Object.entries(expected).filter(([key, value]) => settings[key] !== value);',
  '',
].join('\n');

/** A `gh` on PATH that logs its calls, serves `guard` as the release's release.yml, and echoes a PATCH's fields back, but `drop`. */
const fakeGh = (dir) => {
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args.some((a) => a.includes('contents/.github/workflows/release.yml'))) {
  if (!fs.existsSync(process.env.GUARD_FILE)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  process.stdout.write(fs.readFileSync(process.env.GUARD_FILE, 'utf8'));
  process.exit(0);
}
const i = args.indexOf('-X');
if (i >= 0 && args[i + 1] === 'PATCH') {
  const out = ['allow_auto_merge=false', 'delete_branch_on_merge=false'];
  for (let j = 0; j < args.length; j++) {
    if (args[j] !== '-f' && args[j] !== '-F') continue;
    const [k, v] = args[++j].split('=');
    out.push(k + '=' + (k === process.env.DROP ? 'stale' : v));
  }
  process.stdout.write(out.join('\\n') + '\\n');
  process.exit(0);
}
process.stderr.write('fake gh: no route for ' + args.join(' ') + '\\n');
process.exit(1);
`);
  chmodSync(gh, 0o755);
};

/** Runs the step's script against a release whose release.yml is `guard` (a string, or null for none). */
const runStep = (guard, { drop = '' } = {}) => {
  const dir = tempDir('provision-');
  fakeGh(dir);
  const guardFile = join(dir, 'release.yml');
  if (guard !== null) writeFileSync(guardFile, guard);
  const log = join(dir, 'gh.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', ['-e', '-c', step.run], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 'token', ORG: 'kanon-e2e', REPO_NAME: 'e2e-x-1-1', RELEASE, GH_LOG: log, GUARD_FILE: guardFile, DROP: drop },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
};

/** The fields a PATCH sent, as `{ key: value }`, typed as `-F` (JSON) or `-f` (string) sends them. */
const patched = (calls) => {
  const call = calls.find((c) => c.includes('PATCH'));
  if (!call) return null;
  const fields = {};
  for (let i = 0; i < call.length; i++) {
    if (call[i] !== '-f' && call[i] !== '-F') continue;
    const [k, v] = call[++i].split('=');
    fields[k] = call[i - 1] === '-F' ? JSON.parse(v) : v;
  }
  return { path: call.find((a) => a.startsWith('repos/')), fields };
};

describe('provision sets the merge settings the release under test\'s guard checks (K-ADOPT-1 step 5, #36)', () => {
  it('runs in `provision`, with the repository\'s Administration: write token, before the repository is marked provisioned', () => {
    expect(step, NAME).toBeDefined();
    const at = provision.steps.indexOf(step);
    expect(at).toBeGreaterThan(provision.steps.findIndex((s) => s.id === 'repo'));
    expect(at).toBeLessThan(provision.steps.findIndex((s) => /kanon-e2e-provisioned/.test(s.run ?? '')));
    expect(provision.steps.find((s) => s.id === 'repo').with['permission-administration']).toBe('write');
    expect(step.env).toEqual({ GH_TOKEN: '${{ steps.repo.outputs.token }}', RELEASE: '${{ needs.plan.outputs.release }}' });
    expect(step.run).not.toMatch(/\$\{\{/);
  });

  it('reads the guard from the release under test, and sets exactly the values it checks, typed as it checks them', () => {
    const { status, out, calls } = runStep(guardYml(MERGE_SETTINGS));
    expect(status, out).toBe(0);
    expect(calls[0].join(' ')).toContain(`repos/yedeya-labs/kanon/contents/.github/workflows/release.yml?ref=${RELEASE}`);
    expect(patched(calls)).toEqual({ path: 'repos/kanon-e2e/e2e-x-1-1', fields: MERGE_SETTINGS });
  });

  it('holds no copy of the values: a guard that checks others gets those', () => {
    const other = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false, squash_merge_commit_title: 'COMMIT_OR_PR_TITLE', squash_merge_commit_message: 'COMMIT_MESSAGES' };
    const { status, out, calls } = runStep(guardYml(other));
    expect(status, out).toBe(0);
    expect(patched(calls).fields).toEqual(other);
  });

  it('fails closed, setting nothing, when the release has no release.yml, no guard, or a guard field it can\'t read', () => {
    for (const [guard, why] of [
      [null, /release\.yml/],
      ['jobs: {}\n', /no merge settings/],
      [guardYml({ ...MERGE_SETTINGS, archived: true }), /archived: true/],
      [guardYml({ ...MERGE_SETTINGS, squash_merge_commit_title: 'pr title; rm -rf /' }), /squash_merge_commit_title/],
    ]) {
      const { status, out, calls } = runStep(guard);
      expect(status, out).not.toBe(0);
      expect(out).toMatch(why);
      expect(patched(calls)).toBeNull();
    }
  });

  it('fails when GitHub\'s answer to the PATCH doesn\'t carry a value the guard checks', () => {
    const { status, out } = runStep(guardYml(MERGE_SETTINGS), { drop: 'squash_merge_commit_message' });
    expect(status).not.toBe(0);
    expect(out).toMatch(/squash_merge_commit_message=PR_BODY/);
  });

  // Where a checkout of Kanon is at hand (`KANON`, as Kanon's lanes set it), the real guard: the
  // step reads it whole, and repo.apply's `merge.settings` copy (runner/lib/adopt.mjs) agrees.
  const real = process.env.KANON ? join(process.env.KANON, '.github/workflows/release.yml') : '';
  it.skipIf(!real || !existsSync(real))('with a checkout of Kanon, reads its real guard, which checks K-SHIP-3\'s squash-only, PR title and PR body', () => {
    const { status, out, calls } = runStep(readFileSync(real, 'utf8'));
    expect(status, out).toBe(0);
    expect(patched(calls).fields).toEqual(MERGE_SETTINGS);
  });
});
