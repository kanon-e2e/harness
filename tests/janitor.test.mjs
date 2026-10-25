import { describe, expect, it } from 'vitest';
import { CUTOFFS, sweep, summary } from '../janitor/janitor.mjs';
import { janitorCutoffs, longestRunningMinutes, maxScenarios, SETTINGS } from '../runner/sizing.mjs';
import { retrying } from '../runner/lib/retry.mjs';
import { fail, stubGh } from './helpers/stubs.mjs';

/**
 * The janitor (Kanon plan 0012 §5.3; harness #16): it deletes each repository of the test
 * organisation that carries the `kanon-e2e` topic and is past its cut-off, never one without the
 * topic, never the harness, and fails its run on one older than a day it couldn't delete.
 */

const NOW = Date.parse('2026-10-17T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const repo = (name, ageHours, topics = ['kanon-e2e']) => ({ name, full_name: `kanon-e2e/${name}`, created_at: hoursAgo(ageHours), topics });
const LIST = 'GET orgs/kanon-e2e/repos?per_page=100&type=all';

const run = async (repos, deletes = {}) => {
  const g = stubGh({
    [LIST]: [repos],
    ...Object.fromEntries(repos.map((r) => [`DELETE repos/${r.full_name}`, deletes[r.name] ?? undefined])),
  });
  const out = await sweep({ now: NOW }, { gh: g.gh });
  return { ...out, removed: g.writes().map((c) => c.key.replace('DELETE repos/kanon-e2e/', '')), g };
};

describe('the janitor\'s cut-offs follow the sizing', () => {
  it('the cut-off is at least the longest running time plus the margin; the failed topic\'s is 24 hours beyond', () => {
    expect(CUTOFFS).toEqual(janitorCutoffs());
    expect(CUTOFFS.cutoffMinutes).toBeGreaterThanOrEqual(longestRunningMinutes(maxScenarios()) + SETTINGS.queueMarginMinutes);
    expect(CUTOFFS.failedCutoffMinutes).toBeGreaterThanOrEqual(CUTOFFS.cutoffMinutes + 24 * 60);
  });
});

describe('the janitor deletes only topic-marked repositories past their age', () => {
  const cut = CUTOFFS.cutoffMinutes / 60;
  const failedCut = CUTOFFS.failedCutoffMinutes / 60;

  it('deletes a `kanon-e2e` repository past the cut-off, and leaves one inside it', async () => {
    const { removed, ok } = await run([repo('e2e-old-1-1', cut + 0.1), repo('e2e-young-2-1', cut - 0.1)]);
    expect(removed).toEqual(['e2e-old-1-1']);
    expect(ok).toBe(true);
  });

  it('keeps a failed repository 24 hours longer, archived or not', async () => {
    const failed = ['kanon-e2e', 'kanon-e2e-provisioned', 'kanon-e2e-failed'];
    const { removed } = await run([repo('e2e-kept-1-1', failedCut - 0.1, failed), repo('e2e-due-2-1', failedCut + 0.1, failed)]);
    expect(removed).toEqual(['e2e-due-2-1']);
  });

  it('never deletes a repository without the topic, however old', async () => {
    const { removed } = await run([repo('someones-project', 1000, []), repo('e2e-unmarked-1-1', 1000, ['kanon-e2e-provisioned'])]);
    expect(removed).toEqual([]);
  });

  it('never deletes the harness repository, even marked and old', async () => {
    const { removed } = await run([repo('harness', 1000, ['kanon-e2e'])]);
    expect(removed).toEqual([]);
  });

  it('fails its run on a repository older than a day it couldn\'t delete, and says which', async () => {
    const out = await run([repo('e2e-stuck-1-1', 30), repo('e2e-gone-2-1', 30)], { 'e2e-stuck-1-1': fail('HTTP 403: Must have admin rights'), 'e2e-gone-2-1': fail('HTTP 404: Not Found') });
    expect(out.ok).toBe(false);
    expect(out.failed).toEqual([expect.objectContaining({ name: 'e2e-stuck-1-1', why: expect.stringMatching(/403/) })]);
    expect(summary(out)).toMatch(/e2e-stuck-1-1/);
  });

  it('writes each deletion and each repository it left to its summary', async () => {
    const out = await run([repo('e2e-old-1-1', cut + 1), repo('e2e-young-2-1', 1)]);
    const { removed: _, g: __, ...sweep } = out;
    const text = summary(sweep);
    expect(text).toMatch(/Deleted[\s\S]*e2e-old-1-1/);
    expect(text).toMatch(/Left[\s\S]*e2e-young-2-1/);
  });
});

describe('a DELETE GitHub carried out before its 502 is looked up, not asked again (#130)', () => {
  it('reads the repository gone, and counts it deleted', async () => {
    let gone = false;
    const old = repo('e2e-old-1-1', CUTOFFS.cutoffMinutes / 60 + 1);
    const g = stubGh({
      [LIST]: [[old]],
      [`DELETE repos/${old.full_name}`]: () => { gone = true; return fail('gh: HTTP 502: Bad Gateway'); },
      [`GET repos/${old.full_name}`]: () => (gone ? fail('gh: Not Found (HTTP 404)') : old),
    });
    const out = await sweep({ now: NOW }, { gh: retrying(g.gh, { sleep: async () => {} }) });
    expect(out.deleted.map((d) => d.name)).toEqual(['e2e-old-1-1']);
    expect(g.writes()).toHaveLength(1);
  });
});
