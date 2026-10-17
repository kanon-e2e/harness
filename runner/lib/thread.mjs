// What `expect.issue` and `expect.pr` share: an issue's or a pull request's state, labels, its
// author's App slug, and a known marker in its body, a comment or (on a pull request) a review,
// optionally by a given App. A body is searched for the marker alone; its words are never read.

import { AUTHOR, markerProblems } from './expect.mjs';
import { str, strs } from './args.mjs';
import { api, botLogin, repoPath } from './gh.mjs';
import { markerById } from './markers.mjs';
import { met, unmet } from './poll.mjs';
import { differs } from './state.mjs';

/** The arguments both take, beside the one naming the issue or pull request. @param {string[]} states */
export const threadArgs = (states) => ({
  state: str({ enum: states }),
  labels: strs(),
  labelsAbsent: strs(),
  author: AUTHOR,
  marker: str(),
  markerBy: AUTHOR,
});

/** @param {any} step */
export const threadProblems = (step) => [
  ...markerProblems(step.marker),
  ...(step.markerBy !== undefined && step.marker === undefined ? ['`markerBy` goes with `marker`'] : []),
];

/**
 * A probe of issue or pull request `number` against the step.
 * @param {any} ctx @param {any} step @param {number} number @param {boolean} isPr
 */
export const threadProbe = (ctx, step, number, isPr) => async () => {
  const it = await api(ctx, repoPath(ctx, `${isPr ? 'pulls' : 'issues'}/${number}`));
  const p = [];
  if (step.state !== undefined) p.push(differs('state', step.state, isPr && it.merged ? 'merged' : it.state));
  const labels = (it.labels ?? []).map((/** @type {any} */ l) => l.name);
  for (const l of step.labels ?? []) if (!labels.includes(l)) p.push(`label \`${l}\`: missing`);
  for (const l of step.labelsAbsent ?? []) if (labels.includes(l)) p.push(`label \`${l}\`: present`);
  if (step.author !== undefined) p.push(differs('author', botLogin(step.author), it.user?.login));
  if (step.marker !== undefined) {
    const marker = /** @type {RegExp} */ (markerById(step.marker));
    const posts = [
      { body: it.body, user: it.user },
      ...(await api(ctx, repoPath(ctx, `issues/${number}/comments?per_page=100`), { paginate: true })),
      ...(isPr ? await api(ctx, repoPath(ctx, `pulls/${number}/reviews?per_page=100`), { paginate: true }) : []),
    ];
    const by = step.markerBy === undefined ? null : botLogin(step.markerBy);
    if (!posts.some((x) => marker.test(String(x.body ?? '')) && (!by || x.user?.login === by))) {
      p.push(`no post carries the marker \`${step.marker}\`${by ? ` by \`${step.markerBy}\`` : ''}`);
    }
  }
  const problems = p.filter(Boolean);
  return problems.length ? unmet(`${isPr ? 'pull request' : 'issue'} #${number}: ${problems.join('; ')}`) : met();
};
