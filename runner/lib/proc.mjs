// The runner's one way to run a process (E4): `exec(cmd, args, { cwd, env, input })` resolves to
// `{ status, stdout, stderr }` and never throws for a non-zero exit, so the caller decides what an
// exit means. No shell: each argument goes to the process as it is.

import { spawn } from 'node:child_process';

/**
 * Runs `cmd` with `args`, and collects what it printed.
 * @param {string} cmd @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string }} [opts]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
export const exec = (cmd, args, { cwd, env, input } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  child.on('error', (e) => resolve({ status: 127, stdout, stderr: `${stderr}${e.message}` }));
  child.on('close', (code, signal) => resolve({ status: code ?? (signal ? 128 : 1), stdout, stderr }));
  child.stdin.on('error', () => {});
  child.stdin.end(input ?? '');
});

/**
 * `gh`, as the verbs take it: `gh(args, input)`, the input sent on standard input.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const ghProcess = (env) => (/** @type {string[]} */ args, /** @type {string} [input] */ input) => exec('gh', args, { env, input });
