// Retries and classification (Kanon plan 0012 §10). A call to GitHub, by `gh` or by `git`, that
// fails on a 5xx, a rate limit, a network error or GitHub's own failure to answer is retried, up
// to three times, backing off; a write only after a lookup says its first attempt didn't land
// (#130), or, with no lookup, only while GitHub can't have acted on it (#137). A false
// expectation never is: it is the finding. What is left after the retries is `infra`, as is a
// token that no longer works (401). Anything else that isn't a `Fail` is the harness's own error,
// and reads `fail`, so a broken runner is never mistaken for a quiet infrastructure day.

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
// `gh` names a host it couldn't look up `error connecting to <host>`, and hides the resolver's own
// words unless debugging (cli/cli `internal/ghcmd/cmd.go`, `printError`).
const NETWORK = /^error connecting to\b|connection reset|connection refused|i\/o timeout|timed out|TLS handshake|\bEOF\b|no such host|temporary failure in name resolution|network is unreachable|could not resolve host|failed to connect to|couldn't connect to server|RPC failed; curl (?:7|18|28|35|52|55|56|92)\b/im;
// GitHub failing on its side with no status to show for it (harness #70): `gh`'s Go parser on a
// body that was cut off, and GitHub's git server failing to write a ref it accepted. A ruleset's
// refusal names its reason in the parentheses (`push declined due to repository rule
// violations`, `protected branch hook declined`), never `failure`, so it stays a `fail`.
const GITHUB = /unexpected end of JSON input|^remote: fatal error in\b|\[remote rejected\][^\n]*\(failure\)/m;
// What GitHub refused before acting on, or a request that never reached it (#137): a rate limit,
// which GitHub answers instead of acting, and the connection never made, by `gh` (Go's `dial`
// errors, and the `error connecting to` above) and by `git` (curl's 6 and 7). A reset, a timeout,
// an `EOF`, a 5xx or a cut-off answer may come after GitHub acted, so none of them is here, nor an
// unreachable network outside `connect`. A subset of `isRetryable`.
const UNREACHED = /^error connecting to\b|connect: connection refused|connect: network is unreachable|no such host|temporary failure in name resolution|could not resolve host|failed to connect to|couldn't connect to server/im;
const EXPIRED = /\bHTTP 401\b|Bad credentials/;

/** Whether a failed call is worth asking again. @param {{ status: number, stderr?: string }} r */
export const isRetryable = (r) => r.status !== 0 && (SERVER.test(String(r.stderr)) || RATE.test(String(r.stderr)) || NETWORK.test(String(r.stderr)) || GITHUB.test(String(r.stderr)));

/** Whether a failed call is one GitHub can't have acted on, so that a write is safe to ask again. @param {{ status: number, stderr?: string }} r */
export const isUnreached = (r) => r.status !== 0 && (RATE.test(String(r.stderr)) || UNREACHED.test(String(r.stderr)));

// A write GitHub may have committed before its answer was lost (#130): a POST, a DELETE, a GraphQL
// mutation, or a `gh` command that isn't a read. A PUT or a PATCH sets a whole state, so asking it
// again leaves the same state: it is retried as a read is (confirmed by the Owner, 2026-10-26, #137).
const READS = new Set(['view', 'list', 'download', 'status', 'diff', 'checks']);
const queryOf = (/** @type {string | undefined} */ input) => {
  try {
    return String(JSON.parse(String(input)).query ?? '');
  } catch {
    return '';
  }
};

/**
 * Whether a `gh` call writes, so that asking it again could write twice.
 * @param {string[]} args @param {string} [input]
 */
export const isWrite = (args, input) => {
  if (args[0] !== 'api') return !READS.has(String(args[1]));
  const at = args.indexOf('-X');
  const method = at >= 0 ? String(args[at + 1]).toUpperCase() : 'GET';
  if (method !== 'POST' && method !== 'DELETE') return false;
  return args.includes('graphql') ? /^\s*mutation\b/.test(queryOf(input)) : true;
};

/**
 * `gh`, retried: each call that fails retryably is asked again up to three times, after 2, 4 and
 * 8 seconds (a minute on a rate limit), and the last answer is given back as it is.
 *
 * A write is asked again only after a lookup says its first attempt didn't land (the Owner,
 * 2026-10-25, #130): its caller passes `{ landed }`, which reads GitHub (the pull request for the
 * head, the issue, the label, the milestone, the ruleset) and answers `{ answer }`, what the write
 * would have answered, or null. Found, that answer is the call's, and nothing is asked again. A
 * write with no lookup is asked again only while GitHub can't have acted on it, a rate limit or a
 * connection never made (the Owner, 2026-10-26, #137); any other failure comes back as it is, and
 * reads `infra`.
 * @template {(args: string[], input?: string, opts?: { landed?: () => Promise<{ answer: any } | null> }) => Promise<{ status: number, stdout: string, stderr: string }>} G
 * @param {G} gh @param {{ sleep: (ms: number) => Promise<void> }} clock
 * @returns {G}
 */
export const retrying = (gh, clock) => /** @type {G} */ ((args, input, opts) => {
  if (!isWrite(args, input)) return again(() => gh(args, input), clock);
  const landed = opts?.landed;
  if (!landed) return again(() => gh(args, input, opts), clock, undefined, isUnreached);
  return again(() => gh(args, input, opts), clock, async () => {
    const found = await landed();
    return found ? { status: 0, stdout: found.answer == null ? '' : JSON.stringify(found.answer), stderr: '' } : null;
  });
});

/**
 * Asks `call` until it answers other than `retryable`, up to three more times, backing off. Before
 * each time again, `look` may answer in its place.
 * @param {() => Promise<{ status: number, stdout: string, stderr: string }>} call
 * @param {{ sleep: (ms: number) => Promise<void> }} clock
 * @param {() => Promise<{ status: number, stdout: string, stderr: string } | null>} [look]
 * @param {(r: { status: number, stderr?: string }) => boolean} [retryable]
 */
const again = async (call, { sleep }, look, retryable = isRetryable) => {
  let r = await call();
  for (let i = 0; i < RETRIES && retryable(r); i++) {
    await sleep(RATE.test(String(r.stderr)) ? RATE_LIMIT_WAIT_MS : FIRST_BACKOFF_MS * 2 ** i);
    const found = look ? await look() : null;
    if (found) return found;
    r = await call();
  }
  return r;
};

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
export const retryingExec = (exec, clock) => /** @type {E} */ ((cmd, args, opts) => (cmd === 'git' && TRANSPORT.has(String(gitCommand(args))) ? again(() => exec(cmd, args, opts), clock) : exec(cmd, args, opts)));

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
