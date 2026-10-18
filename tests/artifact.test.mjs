import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { takeAsData } from '../runner/lib/artifact.mjs';
import { exec as realExec } from '../runner/lib/proc.mjs';
import { runSegment } from '../runner/run.mjs';
import { RELEASE, fakeClock, scenarioJson, stubGh, tempDir, writeScenario, writeTree } from './helpers/stubs.mjs';

/**
 * The `act` job treats the `kanon` job's artifact as data (Kanon plan 0012 §5.2; harness #16).
 * It unpacks it into a scratch directory, never runs git or anything else there, walks it with
 * `lstat`, and takes only regular files whose path stays inside the tree. A symlink, a device, a
 * hard link, an out-of-tree path, or anything under `.git/` is refused, and the scenario reads
 * `fail`. So a hook, a `core.fsmonitor` setting or a symlink the `kanon` job left runs nothing
 * and reads nothing in the `act` job.
 */

const REPOSITORY = 'kanon-e2e/e2e-sample-123-1';

describe('takeAsData', () => {
  it('takes the regular files, by relative path, with their bytes', () => {
    const dir = writeTree(tempDir('scratch-'), { 'README.md': 'hi\n', '.github/workflows/ci.yml': 'on: push\n', 'docs/qa/x.md': '' });
    expect(takeAsData(dir).map((f) => [f.path, f.bytes.toString()]).sort()).toEqual([
      ['.github/workflows/ci.yml', 'on: push\n'], ['README.md', 'hi\n'], ['docs/qa/x.md', ''],
    ]);
  });

  it('refuses anything under .git/: a hook, a config', () => {
    const hook = writeTree(tempDir('scratch-'), { 'README.md': 'x', '.git/hooks/pre-push': '#!/bin/sh\n' });
    expect(() => takeAsData(hook)).toThrow(/\.git/);
    const config = writeTree(tempDir('scratch-'), { '.git/config': '[core]\n\tfsmonitor = /tmp/x\n' });
    expect(() => takeAsData(config)).toThrow(/\.git/);
    const nested = writeTree(tempDir('scratch-'), { 'vendor/lib/.git/config': '' });
    expect(() => takeAsData(nested)).toThrow(/\.git/);
  });

  it('refuses a symlink, wherever it points', () => {
    const outside = writeTree(tempDir('secret-'), { 'key.pem': 'SECRET' });
    const out = writeTree(tempDir('scratch-'), { 'README.md': 'x' });
    symlinkSync(join(outside, 'key.pem'), join(out, 'leak.txt'));
    expect(() => takeAsData(out)).toThrow(/symlink/);
    const inside = writeTree(tempDir('scratch-'), { 'README.md': 'x' });
    symlinkSync('README.md', join(inside, 'again.md'));
    expect(() => takeAsData(inside)).toThrow(/symlink/);
    const dirLink = writeTree(tempDir('scratch-'), { 'README.md': 'x' });
    symlinkSync(outside, join(dirLink, 'docs'));
    expect(() => takeAsData(dirLink)).toThrow(/symlink/);
  });

  it('refuses a hard link and anything that isn\'t a regular file or a directory', () => {
    const hard = writeTree(tempDir('scratch-'), { 'a.txt': 'x' });
    linkSync(join(hard, 'a.txt'), join(hard, 'b.txt'));
    expect(() => takeAsData(hard)).toThrow(/hard link/);
    const fifo = writeTree(tempDir('scratch-'), { 'a.txt': 'x' });
    execFileSync('mkfifo', [join(fifo, 'pipe')]);
    expect(() => takeAsData(fifo)).toThrow(/not a regular file/);
  });

  it('refuses a scratch directory that is itself a symlink', () => {
    const real = writeTree(tempDir('scratch-'), { 'a.txt': 'x' });
    const link = join(tempDir('scratch-'), 'tree');
    symlinkSync(real, link);
    expect(() => takeAsData(link)).toThrow(/symlink/);
  });
});

describe('the act job runs nothing and copies nothing from an artifact that carries a hook, an fsmonitor or a symlink', () => {
  /**
   * An artifact a hostile `kanon` job could leave: a pre-push hook and a `core.fsmonitor` that
   * each write a marker if anything runs them, and a symlink to a secret outside the tree.
   */
  const hostile = () => {
    const markers = tempDir('markers-');
    const secret = writeTree(tempDir('secret-'), { 'key.pem': 'SECRET-KEY' });
    const scratch = tempDir('scratch-');
    const script = (name) => `#!/bin/sh\ntouch "${join(markers, name)}"\n`;
    writeTree(scratch, {
      'README.md': 'from kanon\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/hooks/pre-push': script('pre-push'),
      '.git/config': `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ${join(markers, 'fsmonitor.sh')}\n`,
    });
    writeFileSync(join(markers, 'fsmonitor.sh'), script('fsmonitor'));
    chmodSync(join(markers, 'fsmonitor.sh'), 0o755);
    chmodSync(join(scratch, '.git/hooks/pre-push'), 0o755);
    mkdirSync(join(scratch, '.git/objects'), { recursive: true });
    mkdirSync(join(scratch, '.git/refs'), { recursive: true });
    symlinkSync(join(secret, 'key.pem'), join(scratch, 'leak.txt'));
    return { scratch, markers };
  };

  it('the trap is real: git run inside such a directory fires its fsmonitor', () => {
    const { scratch, markers } = hostile();
    execFileSync('git', ['status', '--porcelain'], { cwd: scratch, stdio: 'ignore' });
    expect(existsSync(join(markers, 'fsmonitor'))).toBe(true);
  });

  it('reports `fail`, archives the repository, runs no hook or fsmonitor, runs nothing in the scratch directory, and pushes nothing', async () => {
    const { scratch, markers } = hostile();
    const remote = join(tempDir('remote-'), 'repo.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const dir = writeScenario({ scenario: scenarioJson('sample'), steps: { phases: [{ kanon: [], act: [{ verb: 'files.commit', from: 'kanon', message: 'Push what Kanon wrote' }] }] } });
    const g = stubGh({
      [`GET repos/${REPOSITORY}`]: { full_name: REPOSITORY, default_branch: 'main', topics: ['kanon-e2e', 'kanon-e2e-provisioned'] },
      [`PUT repos/${REPOSITORY}/topics`]: {},
      [`PATCH repos/${REPOSITORY}`]: {},
    });
    const calls = [];
    const exec = async (cmd, args, opts = {}) => { calls.push({ cmd, args, cwd: opts.cwd }); return realExec(cmd, args, opts); };
    const clock = fakeClock();
    const state = { schema: 'kanon-e2e-state/v1', scenario: 'sample', repository: REPOSITORY, release: RELEASE, startedAt: clock.now(), laid: false, ref: null, steps: [], result: null, firstFailure: null, finalized: false };
    const { result } = await runSegment({
      segment: 'act', phase: 1, scenarioDir: dir, repository: REPOSITORY, release: RELEASE, trigger: 'nightly', harness: 'kanon-e2e/harness',
      run: { id: '123', attempt: '1', url: 'u' }, state, artifactDir: scratch, work: tempDir('work-'), remote,
    }, { gh: g.gh, exec, now: clock.now, sleep: clock.sleep, log: () => {} });

    expect(result).toMatchObject({ result: 'fail', repositoryAction: 'kept', firstFailure: expect.objectContaining({ message: expect.stringMatching(/refused/) }) });
    expect(g.writes().map((c) => c.key)).toEqual([`PUT repos/${REPOSITORY}/topics`, `PATCH repos/${REPOSITORY}`]);
    expect(existsSync(join(markers, 'pre-push'))).toBe(false);
    expect(existsSync(join(markers, 'fsmonitor'))).toBe(false);
    const inScratch = (p) => typeof p === 'string' && (p === scratch || p.startsWith(`${scratch}/`));
    expect(calls.filter((c) => inScratch(c.cwd) || c.args.some(inScratch))).toEqual([]);
    expect(calls.map((c) => c.cmd).filter((c) => c !== 'git')).toEqual([]);
    expect(execFileSync('git', ['--git-dir', remote, 'rev-list', '--all'], { encoding: 'utf8' }).trim()).toBe('');
  });

  it('takes a clean artifact\'s files into its own clone and pushes them', async () => {
    const scratch = writeTree(tempDir('scratch-'), { 'README.md': `Pinned to ${RELEASE} in ${REPOSITORY}.\n`, '.github/workflows/ci.yml': 'on: push\n' });
    const remote = join(tempDir('remote-'), 'repo.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    const dir = writeScenario({ scenario: scenarioJson('sample'), steps: { phases: [{ kanon: [], act: [{ verb: 'files.commit', from: 'kanon', message: 'Push what Kanon wrote' }] }] } });
    const g = stubGh({ [`GET repos/${REPOSITORY}`]: { default_branch: 'main', topics: ['kanon-e2e', 'kanon-e2e-provisioned'] }, [`DELETE repos/${REPOSITORY}`]: undefined });
    const clock = fakeClock();
    const state = { schema: 'kanon-e2e-state/v1', scenario: 'sample', repository: REPOSITORY, release: RELEASE, startedAt: clock.now(), laid: false, ref: null, steps: [], result: null, firstFailure: null, finalized: false };
    const { result } = await runSegment({
      segment: 'act', phase: 1, scenarioDir: dir, repository: REPOSITORY, release: RELEASE, trigger: 'nightly', harness: 'kanon-e2e/harness',
      run: { id: '123', attempt: '1', url: 'u' }, state, artifactDir: scratch, work: tempDir('work-'), remote,
    }, { gh: g.gh, exec: realExec, now: clock.now, sleep: clock.sleep, log: () => {} });
    expect(result.result).toBe('pass');
    expect(execFileSync('git', ['--git-dir', remote, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim().split('\n')).toEqual(['Push what Kanon wrote', 'Lay the scenario\'s starting tree']);
    expect(execFileSync('git', ['--git-dir', remote, 'show', 'main:.github/workflows/ci.yml'], { encoding: 'utf8' })).toBe('on: push\n');
  });
});
