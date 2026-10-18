// `issue.await` (Kanon plan 0012 step E5): waits for an issue no step of the scenario opened, one a
// workflow under test files, by its author's App slug (`github-actions` for the workflow token)
// and its labels, never its title or body (§4.3). It keeps the newest such issue under `name`,
// for `expect.issue` to hold.

import { NAME, str, strs } from '../lib/args.mjs';
import { AUTHOR } from '../lib/expect.mjs';
import { api, botLogin, repoPath } from '../lib/gh.mjs';
import { met, poll, unmet } from '../lib/poll.mjs';
import { remember } from '../lib/state.mjs';

export default {
  verb: 'issue.await',
  kind: 'read',
  waits: true,
  args: {
    name: str({ required: true, pattern: NAME, defines: 'issues' }),
    author: { ...AUTHOR, required: true },
    labels: strs(),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const login = botLogin(step.author);
    const labels = step.labels ?? [];
    const issue = await poll(ctx, step.deadline, async () => {
      const all = await api(ctx, repoPath(ctx, 'issues?state=all&per_page=100'), { paginate: true });
      const found = all
        .filter((/** @type {any} */ i) => !i.pull_request && i.user?.login === login)
        .filter((/** @type {any} */ i) => labels.every((l) => (i.labels ?? []).some((/** @type {any} */ x) => x.name === l)))
        .reduce((/** @type {any} */ a, /** @type {any} */ i) => (!a || i.number > a.number ? i : a), null);
      return found ? met(found) : unmet(`no issue by ${login}${labels.length ? ` labelled ${labels.join(', ')}` : ''} yet`);
    });
    remember(ctx, 'issues', step.name, issue.number);
  },
};
