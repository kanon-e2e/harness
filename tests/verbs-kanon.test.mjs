import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { RELEASE, context, stubExec, stubGh, tempDir, writeTree } from './helpers/stubs.mjs';

/**
 * The verbs of a `kanon` segment (Kanon plan 0012 §4.2): each runs Kanon's code at the release
 * under test, fetched as an adopter fetches it, against the job's own clone, on a stubbed `npx`.
 * None writes to GitHub: the `kanon` job's token is read-only (decision 23 (b)).
 */

const run = (verb, step, ctx) => VOCABULARY[verb].run({ verb, ...step }, ctx);
const PACKAGE = ['--yes', '--package', `github:yedeya-labs/kanon#${RELEASE}`];
const isNpx = (c) => c.cmd === 'npx';

const INIT_DOC = {
  schema: 'kanon-init/v1', kanon: 'v0.41.0', pin: RELEASE, status: 'steps-left', exitCode: 0, repository: 'kanon-e2e/x',
  inspection: { mergeQueue: 'yes' }, findings: [{ id: 'label.create', category: 'label', blocking: false, subject: 'kanon-e2e/x', message: 'm', fix: { text: 't', commands: [], url: null } }],
};
const DOCTOR_DOC = {
  schema: 'kanon-doctor/v1', kanon: 'v0.41.0', status: 'incomplete', exitCode: 4, findings: [],
  unchecked: [{ check: 'secrets', subject: 'kanon-e2e/x', reason: 'r' }],
};

/** A fake Kanon package, as `npx` would lay it out, for the verbs that load Kanon's files. */
const fakeKanon = () => writeTree(tempDir('kanon-'), {
  'cli/kanon.mjs': '',
  'cli/app-register.mjs': [
    'export const writeRegisterRow = (text, { role, slug, permissions }) => ({',
    "  text: (text ?? '# Agent identities\\n') + `| ${role} | \\`${slug}\\` | ${Object.keys(permissions).join(',')} |\\n`,",
    '  diff: [],',
    '});',
  ].join('\n'),
  'requirements.json': JSON.stringify({
    identities: {
      roles: { implementer: { name: 'Implementer' }, lead: { name: 'Lead' }, reviewer: { name: 'Reviewer' }, merger: { name: 'Merger' }, releaser: {} },
      apps: {
        author: { roles: ['implementer', 'lead'], permissions: { contents: 'write', metadata: 'read' } },
        judge: { roles: ['reviewer', 'merger'], permissions: { checks: 'read' } },
        releaser: { roles: ['releaser'], permissions: { contents: 'write' } },
      },
    },
  }),
});
/** `npx … -c 'readlink …'` answers with the fake package's `kanon` bin. */
const resolvesTo = (root) => [(c) => isNpx(c) && c.args.includes('-c'), () => ({ stdout: `${join(root, 'cli/kanon.mjs')}\n` })];

describe('kanon.init', () => {
  it('runs `kanon init --json --yes --no-apps` with the flags, at the release, in the clone, declining telemetry and sharing, and keeps the document', async () => {
    const x = stubExec([[isNpx, () => ({ status: 0, stdout: JSON.stringify(INIT_DOC) })]]);
    const g = stubGh({});
    const ctx = context({ exec: x.exec, gh: g.gh, clone: '/work/clone' });
    await run('kanon.init', { flags: ['--feature=full', '--review-trigger=labelled', '--sensitive-data'] }, ctx);
    expect(x.calls).toEqual([{
      cmd: 'npx',
      args: [...PACKAGE, 'kanon', 'init', '--json', '--yes', '--no-apps', '--consent', 'no', '--feature=full', '--review-trigger=labelled', '--sensitive-data'],
      cwd: '/work/clone',
    }]);
    expect(ctx.state.documents.init).toEqual({ release: RELEASE, exit: 0, document: INIT_DOC });
    expect(g.calls).toEqual([]);
  });

  it('keeps an error document too, for expect.init to hold', async () => {
    const doc = { schema: 'kanon-init/v1', kanon: 'v0.41.0', status: 'error', exitCode: 2, error: 'e' };
    const ctx = context({ exec: stubExec([[isNpx, () => ({ status: 2, stdout: JSON.stringify(doc) })]]).exec });
    await run('kanon.init', {}, ctx);
    expect(ctx.state.documents.init.exit).toBe(2);
  });

  it('fails by name when init prints no JSON document', async () => {
    const ctx = context({ exec: stubExec([[isNpx, () => ({ status: 1, stdout: 'npm ERR! 404', stderr: '' })]]).exec });
    await expect(run('kanon.init', {}, ctx)).rejects.toThrow(/kanon init.*no JSON document.*exit 1/);
  });
});

describe('kanon.doctor', () => {
  it('runs `kanon doctor --json` at the release in the clone, and keeps the document and its exit code', async () => {
    const x = stubExec([[isNpx, () => ({ status: 4, stdout: JSON.stringify(DOCTOR_DOC) })]]);
    const ctx = context({ exec: x.exec, clone: '/work/clone' });
    await run('kanon.doctor', {}, ctx);
    expect(x.calls).toEqual([{ cmd: 'npx', args: [...PACKAGE, 'kanon', 'doctor', '--json'], cwd: '/work/clone' }]);
    expect(ctx.state.documents.doctor).toEqual({ release: RELEASE, exit: 4, document: DOCTOR_DOC });
  });

  it('with `to`, checks against the release under test', async () => {
    const x = stubExec([[isNpx, () => ({ status: 0, stdout: JSON.stringify({ ...DOCTOR_DOC, status: 'healthy', exitCode: 0 }) })]]);
    await run('kanon.doctor', { to: true }, context({ exec: x.exec }));
    expect(x.calls[0].args.slice(-2)).toEqual(['--to', RELEASE]);
  });
});

describe('kanon.at', () => {
  const RELEASES = [
    { tag_name: 'candidate-v0.42.0', draft: false, prerelease: true },
    { tag_name: 'v0.41.0', draft: false, prerelease: false },
    { tag_name: 'v0.40.2', draft: false, prerelease: false },
    { tag_name: 'v0.41.1', draft: true, prerelease: false },
    { tag_name: 'v0.40.10', draft: false, prerelease: false },
    { tag_name: 'v0.39.0', draft: false, prerelease: false },
  ];
  const at = async (release, under = RELEASE, command = 'init') => {
    const x = stubExec([[isNpx, () => ({ status: 0, stdout: JSON.stringify(command === 'init' ? INIT_DOC : DOCTOR_DOC) })]]);
    const g = stubGh({ 'GET repos/yedeya-labs/kanon/releases?per_page=100': [RELEASES] });
    const ctx = context({ exec: x.exec, gh: g.gh, release: under });
    await run('kanon.at', { release, command, ...(command === 'init' ? { flags: ['--feature=review'] } : {}) }, ctx);
    return { ctx, args: x.calls[0].args };
  };

  it('runs init at the previous stable release below the release under test', async () => {
    const { ctx, args } = await at('previous');
    expect(args).toEqual(['--yes', '--package', 'github:yedeya-labs/kanon#v0.40.10', 'kanon', 'init', '--json', '--yes', '--no-apps', '--consent', 'no', '--feature=review']);
    expect(ctx.state.documents.init.release).toBe('v0.40.10');
  });

  it('`previous-1` is the stable release before that; a stable release under test is not its own previous', async () => {
    expect((await at('previous-1')).args[2]).toBe('github:yedeya-labs/kanon#v0.40.2');
    expect((await at('previous', 'v0.41.0')).args[2]).toBe('github:yedeya-labs/kanon#v0.40.10');
  });

  it('runs doctor at a named tag, keeping its document', async () => {
    const { ctx, args } = await at('v0.39.0', RELEASE, 'doctor');
    expect(args).toEqual(['--yes', '--package', 'github:yedeya-labs/kanon#v0.39.0', 'kanon', 'doctor', '--json']);
    expect(ctx.state.documents.doctor.release).toBe('v0.39.0');
  });

  it('fails by name when there is no such previous release', async () => {
    const g = stubGh({ 'GET repos/yedeya-labs/kanon/releases?per_page=100': [[{ tag_name: 'v0.41.0', draft: false, prerelease: false }]] });
    await expect(run('kanon.at', { release: 'previous', command: 'doctor' }, context({ gh: g.gh }))).rejects.toThrow(/no stable release.*previous/);
  });
});

describe('register.write', () => {
  it('writes the register\'s rows for the scenario\'s test Apps with the release\'s own library, without a key', async () => {
    const root = fakeKanon();
    const clone = tempDir('clone-');
    const x = stubExec([resolvesTo(root)]);
    const ctx = context({ exec: x.exec, clone, scenario: { id: 's', apps: ['author', 'judge'] } });
    await run('register.write', {}, ctx);
    expect(x.calls).toEqual([{ cmd: 'npx', args: [...PACKAGE, '-c', 'readlink -f "$(command -v kanon)"'], cwd: clone }]);
    const register = readFileSync(join(clone, 'docs/qa/agent-identities.md'), 'utf8');
    expect(register).toContain('| Implementer | `kanon-e2e-author` | contents,metadata |');
    expect(register).toContain('| Lead | `kanon-e2e-author` |');
    expect(register).toContain('| Reviewer | `kanon-e2e-judge` | checks |');
    expect(register).toContain('| Merger | `kanon-e2e-judge` |');
    expect(register).not.toContain('releaser');
  });

  it('writes the rows at another release, `previous`, `previous-1` or a tag, as kanon.at resolves it', async () => {
    const root = fakeKanon();
    const releases = { 'GET repos/yedeya-labs/kanon/releases?per_page=100': [[
      { tag_name: 'v0.40.2', draft: false, prerelease: false },
      { tag_name: 'v0.40.1', draft: false, prerelease: false },
      { tag_name: RELEASE, draft: false, prerelease: true },
    ]] };
    for (const [release, tag] of [['previous', 'v0.40.2'], ['previous-1', 'v0.40.1'], ['v0.39.0', 'v0.39.0']]) {
      const clone = tempDir('clone-');
      const x = stubExec([resolvesTo(root)]);
      await run('register.write', { release }, context({ exec: x.exec, gh: stubGh(releases).gh, clone, scenario: { id: 's', apps: ['judge'] } }));
      expect(x.calls).toEqual([{ cmd: 'npx', args: ['--yes', '--package', `github:yedeya-labs/kanon#${tag}`, '-c', 'readlink -f "$(command -v kanon)"'], cwd: clone }]);
      expect(readFileSync(join(clone, 'docs/qa/agent-identities.md'), 'utf8')).toContain('| Reviewer | `kanon-e2e-judge` | checks |');
    }
  });

  it('refuses an App the release doesn\'t know', async () => {
    const root = fakeKanon();
    const ctx = context({ exec: stubExec([resolvesTo(root)]).exec, clone: tempDir(), scenario: { id: 's', apps: ['reporter'] } });
    await expect(run('register.write', {}, ctx)).rejects.toThrow(/reporter/);
  });
});

describe('pins.move', () => {
  it('runs the release\'s scripts/move-pins.mjs on the clone, to the release under test', async () => {
    const root = fakeKanon();
    const x = stubExec([resolvesTo(root), [(c) => c.cmd === 'node', () => ({ status: 0, stdout: '.github/workflows/ci.yml\n' })]]);
    const ctx = context({ exec: x.exec, clone: '/work/clone' });
    await run('pins.move', {}, ctx);
    expect(x.calls[0].args.slice(0, 3)).toEqual(PACKAGE);
    expect(x.calls[1]).toEqual({ cmd: 'node', args: [join(root, 'scripts/move-pins.mjs'), RELEASE, '--root', '/work/clone'], cwd: '/work/clone' });
    expect(ctx.state.moved).toEqual(['.github/workflows/ci.yml']);
  });

  it('fails when the script does', async () => {
    const root = fakeKanon();
    const x = stubExec([resolvesTo(root), [(c) => c.cmd === 'node', () => ({ status: 2, stdout: '', stderr: 'not an exact release' })]]);
    await expect(run('pins.move', {}, context({ exec: x.exec }))).rejects.toThrow(/move-pins.*exit 2.*not an exact release/);
  });
});
