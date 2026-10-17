// Retries and classification (Kanon plan 0012 §10). A call to GitHub that fails on a 5xx, a rate
// limit or a network error is retried, up to three times, backing off; a false expectation never
// is: it is the finding. What is left after the retries is `infra`, as is a token that no longer
// works (401). Anything else that isn't a `Fail` is the harness's own error, and reads `fail`,
// so a broken runner is never mistaken for a quiet infrastructure day.

import { Fail } from './fail.mjs';

export const RETRIES = 3;
export const FIRST_BACKOFF_MS = 2_000;
/** How long a rate-limited call waits before it asks again. */
export const RATE_LIMIT_WAIT_MS = 60_000;

const SERVER = /\bHTTP 5\d\d\b/;
const RATE = /rate limit/i;
const NETWORK = /connection reset|connection refused|i\/o timeout|timed out|TLS handshake|EOF|no such host|temporary failure in name resolution|network is unreachable/i;
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
