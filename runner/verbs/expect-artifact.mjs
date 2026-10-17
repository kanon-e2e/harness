// `expect.artifact` (Kanon plan 0012 §4.2): holds a run `run.await` kept to having an artifact
// of a name, such as a model lane's recorded row. It polls until it holds or its deadline passes.

import { NAME, str } from '../lib/args.mjs';
import { api, repoPath } from '../lib/gh.mjs';
import { met, poll, unmet } from '../lib/poll.mjs';
import { named } from '../lib/state.mjs';

export default {
  verb: 'expect.artifact',
  kind: 'read',
  waits: true,
  args: {
    run: str({ required: true, pattern: NAME, ref: 'runs' }),
    name: str({ required: true, pattern: /^[A-Za-z0-9._-]+$/ }),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const id = named(ctx, 'runs', step.run);
    await poll(ctx, step.deadline, async () => {
      const names = (await api(ctx, repoPath(ctx, `actions/runs/${id}/artifacts?per_page=100`))).artifacts.map((/** @type {any} */ a) => a.name);
      return names.includes(step.name) ? met() : unmet(`no artifact \`${step.name}\` on run ${id}; the run has ${names.length ? names.map((n) => `\`${n}\``).join(', ') : 'none'}`);
    });
  },
};
