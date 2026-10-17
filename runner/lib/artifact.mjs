// The `kanon` job's artifact, taken as data (Kanon plan 0012 §5.2, §11; harness #16). The `act`
// job unpacks it into a scratch directory and never runs git or anything else there: a `.git/`
// the artifact carried could hold a hook or a `core.fsmonitor` that would run with the `act`
// job's wide token. It walks the tree with `lstat` and takes only regular files, each opened
// without following a link and held to one link, and refuses the whole artifact on anything
// else, so a symlink to a secret, a hard link, a device or a FIFO reads nothing.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** @typedef {{ path: string, bytes: Buffer }} File */

/** Refuses the artifact. @param {string} why */
const refuse = (why) => { throw new Error(`refused the kanon job's artifact: ${why}`); };

/**
 * Every regular file under `root`, by relative path, with its bytes. Throws on a `.git` anywhere,
 * a symlink, a hard link or anything that isn't a regular file or a directory.
 * @param {string} root @returns {File[]}
 */
export function takeAsData(root) {
  if (lstatSync(root).isSymbolicLink()) refuse(`${root} is a symlink`);
  if (!lstatSync(root).isDirectory()) refuse(`${root} is not a directory`);
  /** @type {File[]} */
  const files = [];
  const walk = (/** @type {string} */ dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (name === '.git') refuse(`\`${rel}\` is a .git: the artifact carries no repository`);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) refuse(`\`${rel}\` is a symlink`);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) refuse(`\`${rel}\` is not a regular file`);
      const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const held = fstatSync(fd);
        if (!held.isFile()) refuse(`\`${rel}\` is not a regular file`);
        if (held.nlink !== 1) refuse(`\`${rel}\` is a hard link`);
        if (held.ino !== st.ino || held.dev !== st.dev) refuse(`\`${rel}\` changed while it was read`);
        files.push({ path: rel.split(sep).join('/'), bytes: readFileSync(fd) });
      } finally {
        closeSync(fd);
      }
    }
  };
  walk(root);
  return files;
}
