// How a verb waits (Kanon plan 0012 §10): every read after a write polls, never sleeps a fixed
// time. It asks its predicate, backs off from 2 to 30 seconds, and asks again until the predicate
// holds or the deadline passes. A deadline that passes is `fail`, not `infra`.

import { Fail } from './fail.mjs';

export const FIRST_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 30_000;

/** @typedef {{ ok: true, value?: any } | { ok: false, why: string }} Probe */

/** A predicate's answer: it holds, with what it read. @param {any} [value] @returns {Probe} */
export const met = (value) => ({ ok: true, value });
/** A predicate's answer: it doesn't hold yet, and why. @param {string} why @returns {Probe} */
export const unmet = (why) => ({ ok: false, why });

/** When a step's deadline, in minutes, passes. @param {{ now: () => number }} ctx @param {number} minutes */
export const deadlineAt = (ctx, minutes) => ctx.now() + minutes * 60_000;

/**
 * Asks `probe` until it holds, backing off from 2 to 30 seconds, and returns what it read. Throws
 * `Fail` naming the last thing it saw once the deadline passes. It never sleeps past the
 * deadline, and asks once more at it.
 * @param {{ now: () => number, sleep: (ms: number) => Promise<void> }} ctx
 * @param {number} minutes the step's deadline
 * @param {() => Promise<Probe>} probe
 * @param {number} [end] an earlier step's end, for a verb that waits on more than one thing
 */
export async function poll(ctx, minutes, probe, end = deadlineAt(ctx, minutes)) {
  let delay = FIRST_DELAY_MS;
  for (;;) {
    const answer = await probe();
    if (answer.ok) return answer.value;
    const left = end - ctx.now();
    if (left <= 0) throw new Fail(`the deadline of ${minutes} minute${minutes === 1 ? '' : 's'} passed: ${answer.why}`);
    await ctx.sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}
