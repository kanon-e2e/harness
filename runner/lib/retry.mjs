// Retries and classification (Kanon plan 0012 §10). A call to GitHub, by `gh` or by `git`, that
// fails on a 5xx, a rate limit or a network error is retried, up to three times, backing off; a
// false expectation never is: it is the finding. What is left after the retries is `infra`, as is a token that no longer
// works (401). Anything else that isn't a `Fail` is the harness's own error, and reads `fail`,
// so a broken runner is never mistaken for a quiet infrastructure day.

import { Fail } from './fail.mjs';

export const RETRIES = 3;
export const FIRST_BACKOFF_MS = 2_000;
/** How long a rate-limited call waits before it asks again. */
export const RATE_LIMIT_WAIT_MS = 60_000;

// `gh`'s wording, and `git`'s over HTTPS: curl's `returned error: 502`, and the curl codes that are
// the connection's failure, not GitHub's answer (7, 18, 28, 35, 52, 55, 56, 92). curl 22 is an HTTP
// error GitHub gave, a 4xx as well as a 5xx, so it is left to the status after it.
const SERVER = /\bHTTP 5\d\d\b|returned error: 5\d\d\b/;
const RATE = /rate limit/i;
const NETWORK = /connection reset|connection refused|i\/o timeout|timed out|TLS handshake|\bEOF\b|no such host|temporary failure in name resolution|network is unreachable|could not resolve host|failed to connect to|couldn't connect to server|RPC failed; curl (?:7|18|28|35|52|55|56|92)\b/i;
const EXPIRED = /\bHTTP 401\b|Bad credentials/;

/** Whether a failed call is worth asking again. @param {{ status: number, stderr?: string }} r */
export const isRetryable = (r) => r.status !== 0 && (SERVER.test(String(r.stderr)) || RATE.test(String(r.stderr)) || NETWORK.test(String(r.stderr)));

/**
 * `gh`, retried: each call that fails retryably is asked again up to three times, after 2, 4 and
 * 8 seconds (a minute on a rate limit), and the last answer is given back as it is.
 * @template {(...a: any[]) => Promise<{ status: number, stdout: string, stderr: string }>} G
 * @param {G} gh @param {{ sleep: (ms: number) => Promise<void> }} clock
 * @returns {G}
 */
export const retrying = (gh, { sleep }) => /** @type {G} */ (async (...a) => {
  let r = await gh(...a);
  for (let i = 0; i < RETRIES && isRetryable(r); i++) {
    await sleep(RATE.test(String(r.stderr)) ? RATE_LIMIT_WAIT_MS : FIRST_BACKOFF_MS * 2 ** i);
    r = await gh(...a);
  }
  return r;
});

/** `git`'s commands that talk to GitHub, and so are retried as a `gh` call is. */
const TRANSPORT = new Set(['clone', 'fetch', 'push', 'ls-remote']);

/** `git`'s command in `args`: the first word after its options, `-c` and `-C` taking a value. @param {string[]} args */
const gitCommand = (args) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return undefined;
};

/**
 * The runner's `exec`, with `git`'s clone, fetch, push and ls-remote retried as `gh` is. Asking
 * again is safe: a failed clone leaves no directory behind, and a push is never forced, so one
 * that landed before its answer was lost either finds the branch where it left it, and succeeds,
 * or finds it moved, and is refused; it never moves the branch back.
 * @template {(cmd: string, args: string[], opts?: any) => Promise<{ status: number, stdout: string, stderr: string }>} E
 * @param {E} exec @param {{ sleep: (ms: number) => Promise<void> }} clock
 * @returns {E}
 */
export const retryingExec = (exec, clock) => {
  const retried = retrying(exec, clock);
  return /** @type {E} */ ((cmd, args, opts) => (cmd === 'git' && TRANSPORT.has(String(gitCommand(args))) ? retried(cmd, args, opts) : exec(cmd, args, opts)));
};

/**
 * What an error thrown by a step makes the scenario: `fail` for a false expectation or a deadline
 * passed; `infra` for GitHub's failure the retries outlasted, or an expired token; `fail` for
 * anything else.
 * @param {unknown} e @returns {'fail' | 'infra'}
 */
export const classify = (e) => {
  if (e instanceof Fail) return 'fail';
  const err = /** @type {any} */ (e);
  if (err?.infra) return 'infra';
  const stderr = String(err?.stderr ?? '');
  if (stderr && (isRetryable({ status: 1, stderr }) || EXPIRED.test(stderr))) return 'infra';
  return 'fail';
};

/** An error that reads `infra`: the harness's preconditions, not Kanon's behaviour. @param {string} message */
export const infra = (message) => Object.assign(new Error(message), { infra: true });
