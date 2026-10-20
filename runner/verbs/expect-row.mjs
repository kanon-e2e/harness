// `expect.row` (Kanon plan 0012 §6.2, step E10): holds a model lane's telemetry row, the one its
// run uploads whether or not the repository sends telemetry, and keeps the run's cost for the
// real-model ledger. It waits for the run that `run.await` kept to have the artifact
// `kanon-telemetry-<lane>-<run id>-<attempt>` (Kanon's `actions/agent-telemetry`, the version-2
// row), downloads it into a scratch directory, and reads `kanon-telemetry.json` as data: JSON,
// parsed, never run. It reads only fields:
//
//   `schema_version` 2, `row_kind` `run`, and `lane` the step's: else `fail`;
//   `outcome` `unavailable` (the model was never reached, plan 0009 §2): `infra`, which is
//     retried, not failed (§6.2);
//   `total_cost_usd`, a number: kept in the run's state as `costUsd`, added to any earlier row's,
//     before it is compared, so a run past its ceiling is still recorded; then at most the step's
//     `ceilingUsd`, the lane's own `--max-budget-usd`, else `fail`.
//
// The result carries `costUsd`, and `runner/ledger.mjs` reads it as the scenario's history.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NAME, int, str } from '../lib/args.mjs';
import { Fail } from '../lib/fail.mjs';
import { GhError, api, repoPath } from '../lib/gh.mjs';
import { met, poll, unmet } from '../lib/poll.mjs';
import { infra } from '../lib/retry.mjs';
import { named } from '../lib/state.mjs';

/** A Kanon lane's name, as the row's `lane` and the artifact's name carry it. */
const LANE = /^[a-z][a-z-]{0,39}$/;
const FILE = 'kanon-telemetry.json';

export default {
  verb: 'expect.row',
  kind: 'read',
  waits: true,
  args: {
    run: str({ required: true, pattern: NAME, ref: 'runs' }),
    lane: str({ required: true, pattern: LANE }),
    ceilingUsd: int({ required: true, min: 1, max: 1000 }),
  },
  /** @param {any} step @param {any} ctx */
  async run(step, ctx) {
    const id = named(ctx, 'runs', step.run);
    const pattern = new RegExp(`^kanon-telemetry-${step.lane}-${id}-[1-9][0-9]{0,3}$`);
    const name = await poll(ctx, step.deadline, async () => {
      const names = (await api(ctx, repoPath(ctx, `actions/runs/${id}/artifacts?per_page=100`))).artifacts.map((/** @type {any} */ a) => String(a.name));
      const rows = names.filter((n) => pattern.test(n)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
      return rows.length ? met(rows[0]) : unmet(`no telemetry row \`kanon-telemetry-${step.lane}-${id}-<attempt>\` on run ${id}; the run has ${names.length ? names.map((n) => `\`${n}\``).join(', ') : 'none'}`);
    });

    const dir = mkdtempSync(join(tmpdir(), 'row-'));
    /** @type {any} */
    let row;
    try {
      const r = await ctx.gh(['run', 'download', String(id), '-R', ctx.repository, '-n', name, '-D', dir]);
      if (r.status !== 0) throw new GhError(`run download ${id} -n ${name}`, r);
      try {
        row = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
      } catch {
        throw new Fail(`the artifact \`${name}\` holds no ${FILE} that parses as JSON`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Fail(`\`${name}\`'s row is not a JSON object`);
    if (row.schema_version !== 2 || row.row_kind !== 'run') throw new Fail(`\`${name}\`'s row is not a version-2 run row: \`schema_version\` ${JSON.stringify(row.schema_version)}, \`row_kind\` ${JSON.stringify(row.row_kind)}`);
    if (row.lane !== step.lane) throw new Fail(`\`${name}\`'s row: \`lane\`: expected \`${step.lane}\`, read ${JSON.stringify(row.lane)}`);
    if (row.outcome === 'unavailable') throw infra(`the lane's model was never reached: \`${name}\`'s row reads \`outcome\` \`unavailable\`, \`reason\` ${JSON.stringify(row.reason)}`);
    const cost = row.total_cost_usd;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Fail(`\`${name}\`'s row records no cost: \`total_cost_usd\` is ${JSON.stringify(cost)}`);
    ctx.state.costUsd = Math.round(((typeof ctx.state.costUsd === 'number' ? ctx.state.costUsd : 0) + cost) * 1e6) / 1e6;
    if (cost > step.ceilingUsd) throw new Fail(`\`${name}\`'s row: \`total_cost_usd\` ${cost} is past the lane's ceiling of $${step.ceilingUsd}`);
  },
};
