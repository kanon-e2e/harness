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

describe('callers.fix', () => {
  // Callers as an older `kanon init` wrote them: top-level `permissions:`, events under `on:`, the
  // calling job's `secrets:` (#172).
  const TRIAGE = [
    'name: Triage (Implementer)',
    '',
    'on:',
    '  issues:',
    '    types: [labeled]',
    '  workflow_dispatch:',
    '    inputs:',
    '      issue_number:',
    '        description: "Issue number to triage"',
    '        required: true',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  triage:',
    `    uses: yedeya-labs/kanon/.github/workflows/agent-triage.yml@${RELEASE}`,
    '    with:',
    '      issue_number: ${{ inputs.issue_number }}',
    '    secrets:',
    '      AUTHOR_APP_ID: ${{ secrets.AUTHOR_APP_ID }}',
    '      OLD_SECRET: ${{ secrets.OLD_SECRET }}',
    '',
  ].join('\n');
  const RECONCILE = [
    'name: Lead (Lead) — reconcile',
    '',
    'on:',
    '  pull_request_target:',
    '    types: [labeled]',
    '  schedule:',
    '    - cron: "7 * * * *"',
    '  workflow_run:',
    '    workflows: [Review (Reviewer)]',
    '    types: [completed]',
    '',
    'permissions:',
    '  contents: read',
    '  issues: read',
    '',
    'jobs:',
    '  reconcile:',
    `    uses: yedeya-labs/kanon/.github/workflows/agent-lead-reconcile.yml@${RELEASE}`,
    '',
  ].join('\n');
  const T = '.github/workflows/triage.yml';
  const R = '.github/workflows/lead-reconcile.yml';
  const finding = (id, subject, commands, text = 't') => ({ id, category: 'caller', blocking: true, subject, message: 'm', fix: { text, commands, url: null } });
  const doc = (findings) => ({ ...DOCTOR_DOC, findings });
  /** A clone holding the two callers, and `npx` answering each doctor run with the next document. */
  const setup = (...docs) => {
    const clone = writeTree(tempDir('clone-'), { [T]: TRIAGE, [R]: RECONCILE });
    let n = 0;
    const x = stubExec([[isNpx, () => ({ status: 4, stdout: JSON.stringify(docs[Math.min(n++, docs.length - 1)]) })]]);
    return { clone, x, ctx: context({ exec: x.exec, clone }) };
  };
  const read = (clone, path) => readFileSync(join(clone, path), 'utf8');

  it('runs doctor --to the release under test, and with no caller finding writes nothing and runs it once', async () => {
    const { clone, x, ctx } = setup(doc([{ ...finding('label.missing', 'kanon-e2e/x', []), category: 'label' }]));
    await run('callers.fix', {}, ctx);
    expect(x.calls).toEqual([{ cmd: 'npx', args: [...PACKAGE, 'kanon', 'doctor', '--json', '--to', RELEASE], cwd: clone }]);
    expect(read(clone, T)).toBe(TRIAGE);
    expect(ctx.state.callersFixed).toEqual([]);
  });

  it('MUTATION: a grant: adds the permission under the top-level permissions:, or raises a weaker level', async () => {
    const { clone, x, ctx } = setup(doc([finding('caller.grant-missing', T, ['  issues: read', '  contents: write'])]), doc([]));
    await run('callers.fix', {}, ctx);
    expect(read(clone, T)).toBe(TRIAGE.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n  issues: read\n'));
    expect(ctx.state.callersFixed).toEqual([{ id: 'caller.grant-missing', subject: T }]);
    expect(x.calls).toHaveLength(2);
  });

  it('MUTATION: a trigger type: adds an event the caller doesn\'t take at the end of on:, or extends the one event\'s types', async () => {
    const { clone, ctx } = setup(doc([
      finding('caller.event-types-missing', T, ['  issue_comment:', '    types: [created]']),
      finding('caller.event-types-missing', R, ['    types: [labeled, ready_for_review]']),
    ]), doc([]));
    await run('callers.fix', {}, ctx);
    expect(read(clone, T)).toBe(TRIAGE.replace('        required: true\n', '        required: true\n  issue_comment:\n    types: [created]\n'));
    expect(read(clone, R)).toBe(RECONCILE.replace('  pull_request_target:\n    types: [labeled]\n', '  pull_request_target:\n    types: [labeled, ready_for_review]\n'));
  });

  it('MUTATION: a workflow_run: extends its workflows:, or adds the whole trigger to a caller without one', async () => {
    const { clone, ctx } = setup(doc([
      finding('caller.workflow-run-missing', R, ['    workflows: [Review (Reviewer), Implement (Implementer)]']),
      finding('caller.workflow-run-missing', T, ['  workflow_run:', '    workflows: [CI]', '    types: [completed]']),
    ]), doc([]));
    await run('callers.fix', {}, ctx);
    expect(read(clone, R)).toBe(RECONCILE.replace('    workflows: [Review (Reviewer)]\n', '    workflows: [Review (Reviewer), Implement (Implementer)]\n'));
    expect(read(clone, T)).toBe(TRIAGE.replace('        required: true\n', '        required: true\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n'));
  });

  it('MUTATION: a secret mapping: adds a missing one to the job\'s secrets:, and removes a stale one', async () => {
    const { clone, ctx } = setup(doc([
      finding('caller.secret-missing', T, ['      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}', '      AUTHOR_APP_ID: ${{ secrets.AUTHOR_APP_ID }}']),
      finding('caller.secret-stale', T, ['      OLD_SECRET: ${{ secrets.OLD_SECRET }}']),
    ]), doc([]));
    await run('callers.fix', {}, ctx);
    expect(read(clone, T)).toBe(TRIAGE.replace('      OLD_SECRET: ${{ secrets.OLD_SECRET }}\n', '      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n'));
  });

  it('MUTATION: refuses a caller finding it can\'t apply mechanically, by name, and applies none of the others', async () => {
    const { clone, x, ctx } = setup(doc([
      finding('caller.grant-missing', T, ['  issues: read']),
      finding('caller.input-stale', T, []),
    ]));
    await expect(run('callers.fix', {}, ctx)).rejects.toThrow(/can't apply mechanically: caller\.input-stale on \.github\/workflows\/triage\.yml: caller\.input-stale is not a fix callers\.fix applies/);
    await expect(run('callers.fix', {}, setup(doc([finding('caller.input-stale', T, [])])).ctx)).rejects.toMatchObject({ name: 'Fail' });
    expect(read(clone, T)).toBe(TRIAGE);
    expect(x.calls).toHaveLength(1);
  });

  it('MUTATION: refuses a fix that doesn\'t fit the caller as written', async () => {
    const refused = async (f, files = {}, why = /./) => {
      const clone = writeTree(tempDir('clone-'), { [T]: TRIAGE, [R]: RECONCILE, ...files });
      const x = stubExec([[isNpx, () => ({ status: 4, stdout: JSON.stringify(doc([f])) })]]);
      await expect(run('callers.fix', {}, context({ exec: x.exec, clone }))).rejects.toMatchObject({ name: 'Fail', message: expect.stringMatching(why) });
      expect(read(clone, T)).toBe(files[T] ?? TRIAGE);
      expect(read(clone, R)).toBe(RECONCILE);
    };
    // permissions: that isn't a map, and a grant at the job level.
    await refused(finding('caller.grant-missing', T, ['permissions:', '  contents: read', '  issues: read']), {}, /its permissions: is not a map of grants/);
    await refused(finding('caller.grant-missing', T, ['  issues: read']), { [T]: TRIAGE.replace('    uses:', '    permissions:\n      contents: read\n    uses:') }, /grants at the job level/);
    // No event's types the new list extends; an event the caller takes already, added whole.
    await refused(finding('caller.event-types-missing', T, ['    types: [opened]']));
    await refused(finding('caller.event-types-missing', T, ['  issues:', '    types: [labeled, opened]']));
    // A secret line it doesn't map, removed; a finding on a file that isn't a workflow.
    await refused(finding('caller.secret-stale', T, ['      NOT_MAPPED: ${{ secrets.NOT_MAPPED }}']));
    await refused(finding('caller.grant-missing', 'triage.yml', ['  issues: read']));
  });

  it('MUTATION: fails when doctor still reports a caller finding after the fixes', async () => {
    const left = finding('caller.grant-missing', T, ['  issues: read']);
    const { ctx } = setup(doc([left]), doc([left]));
    await expect(run('callers.fix', {}, ctx)).rejects.toThrow(/still reports caller\.grant-missing on \.github\/workflows\/triage\.yml/);
  });
});
