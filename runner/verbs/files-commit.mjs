// `files.commit` (Kanon plan 0012 §4.2): commits files from the scenario's directory, or the
// files the `kanon` segment left, or deletes paths, on a branch or the default branch, and pushes.
// It runs git only in the `act` job's own clone. The `kanon` job's files arrive already taken as
// data (`ctx.kanonFiles`, E4's handling of the crossing artifact); this verb still refuses any
// path outside the clone or under `.git/` before writing a byte, and any path through a symlink
// the checked-out branch holds, since the branch may be one a workflow under test pushed.
// Files `from: scenario` take `start/`'s two substitutions, `{{release}}` and `{{repository}}`,
// so a file committed after the install can pin the release under test (harness E12); the
// validator refuses any other substitution in that directory, as it does in `start/`.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

import { BRANCH, str, strs } from '../lib/args.mjs';
import { strangers, substitute, substituteBytes } from '../lib/substitute.mjs';

/** Who commits: the harness, not a person. */
export const IDENTITY = { name: 'kanon-e2e harness', email: 'kanon-e2e-harness@users.noreply.github.com' };

/** A scenario directory's relative path that stays inside it. */
const INSIDE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

/** The problem with a path a file is written to, or null. @param {string} path */
const outside = (path) => {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return 'not a relative path';
  const n = normalize(path);
  if (n === '..' || n.startsWith(`..${sep}`)) return 'outside the clone';
  if (n === '.git' || n.startsWith(`.git${sep}`)) return 'under .git/';
  return null;
};

/** The first part of `path` under `clone` that exists as a symlink, or null. @param {string} clone @param {string} path */
const symlinked = (clone, path) => {
  let at = clone;
  for (const part of normalize(path).split(sep)) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return relative(clone, at);
  }
  return null;
};

/** Every regular file under `root`, by relative path; a symlink or other file is refused. @param {string} root */
const walk = (root, dir = root) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  const st = lstatSync(full);
  if (st.isDirectory()) return walk(root, full);
  if (!st.isFile()) throw new Error(`refused: ${relative(root, full)} is not a regular file`);
  return [{ path: relative(root, full), bytes: readFileSync(full) }];
});

export default {
  verb: 'files.commit',
  kind: 'act',
  waits: false,
  args: {
    from: str({ enum: ['scenario', 'kanon'] }),
    dir: str({ pattern: INSIDE, hint: 'a directory inside the scenario\'s own' }),
    delete: strs({ items: { pattern: INSIDE, hint: 'a path inside the repository' } }),
    branch: str({ pattern: BRANCH }),
    message: str({ required: true }),
  },
  /** @param {any} step @param {{ scenarioDir?: string }} scope */
  check: (step, scope) => {
    const p = [];
    if (step.from === undefined && step.delete === undefined) p.push('it commits nothing: give `from` or `delete`');
    if ((step.from === 'scenario') !== (step.dir !== undefined)) p.push('`dir` goes with `from: scenario`, and only with it');
    if (step.from === 'scenario' && typeof step.dir === 'string' && INSIDE.test(step.dir) && scope.scenarioDir) {
      let ok = false;
      try {
        ok = lstatSync(join(scope.scenarioDir, step.dir)).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) p.push(`\`dir\` \`${step.dir}\` is not a directory of the scenario's`);
      else {
        try {
          for (const f of walk(join(scope.scenarioDir, step.dir))) {
            for (const s of new Set([...strangers(f.path), ...(f.bytes.includes(0) ? [] : strangers(f.bytes.toString('utf8')))])) p.push(`\`${step.dir}/${f.path}\`: the substitution ${s} is not one of the two, {{release}} and {{repository}}`);
          }
        } catch (e) {
          p.push(`\`dir\` \`${step.dir}\`: ${/** @type {Error} */ (e).message}`);
        }
      }
    }
    return p;
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const values = { release: ctx.release, repository: ctx.repository };
    const files = step.from === 'scenario'
      ? walk(join(ctx.scenarioDir, step.dir)).map((f) => ({ path: substitute(f.path, values), bytes: substituteBytes(f.bytes, values) }))
      : step.from === 'kanon' ? ctx.kanonFiles ?? [] : [];
    for (const f of files) {
      const why = outside(f.path);
      if (why) throw new Error(`refused: \`${f.path}\` is ${why}`);
    }
    const id = ctx.identity ?? IDENTITY;
    // A failure carries git's stderr, so the runner reads a transport error `infra`. `ls-remote
    // --exit-code`'s 2 is an answer, the branch missing, not a failure.
    const git = async (/** @type {string[]} */ args) => {
      const r = await ctx.exec('git', args, { cwd: ctx.clone });
      if (r.status !== 0 && !(args[0] === 'ls-remote' && r.status === 2)) throw Object.assign(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} exited ${r.status}: ${String(r.stderr).trim()}`), { stderr: r.stderr });
      return r;
    };
    const branch = step.branch ?? ctx.defaultBranch;
    await git(['fetch', '-q', 'origin']);
    const exists = step.branch ? (await git(['ls-remote', '--exit-code', '--heads', 'origin', branch])).status === 0 : true;
    await git(['checkout', '-q', '-B', branch, `origin/${exists ? branch : ctx.defaultBranch}`]);
    for (const f of files) {
      const link = symlinked(ctx.clone, f.path);
      if (link) throw new Error(`refused: \`${f.path}\` goes through \`${link}\`, a symlink`);
    }
    for (const f of files) {
      mkdirSync(dirname(join(ctx.clone, f.path)), { recursive: true });
      writeFileSync(join(ctx.clone, f.path), f.bytes);
    }
    for (const path of step.delete ?? []) await git(['rm', '-r', '-q', '--ignore-unmatch', '--', path]);
    await git(['add', '-A']);
    await git(['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, 'commit', '-q', '-m', step.message]);
    await git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  },
};
