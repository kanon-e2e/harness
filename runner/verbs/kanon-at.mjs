// `kanon.at` (Kanon plan 0012 §4.2): runs `init` or `doctor` at another release (`previous`,
// `previous-1`, or a tag), fetched as an adopter fetches it: the upgrade scenarios' starting
// point. It keeps the document where `kanon.init` or `kanon.doctor` would.

import { str, strs } from '../lib/args.mjs';
import { doctorArgs, initArgs, initFlagProblems, keep, resolveRelease, runKanon } from '../lib/kanon.mjs';

export default {
  verb: 'kanon.at',
  kind: 'kanon',
  waits: false,
  args: {
    release: str({ required: true, pattern: /^(?:previous|previous-1|(?:candidate-)?v\d+\.\d+\.\d+)$/, hint: 'previous, previous-1 or an exact release' }),
    command: str({ required: true, enum: ['init', 'doctor'] }),
    flags: strs(),
  },
  check: (/** @type {any} */ step) => [
    ...initFlagProblems(step.flags),
    ...(step.flags !== undefined && step.command === 'doctor' ? ['`flags` are init\'s: doctor takes none'] : []),
  ],
  defines: (/** @type {any} */ step) => [['documents', step.command]],
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const release = await resolveRelease(ctx, step.release);
    const args = step.command === 'init' ? initArgs(step.flags) : doctorArgs();
    keep(ctx, step.command, await runKanon(ctx, release, args));
  },
};
