import { describe, expect, it } from 'vitest';
import { SETTINGS, janitorCutoffs, longestRunningMinutes, maxParallel, maxScenarios, repositoriesOf, sizing, stageMinutes } from '../runner/sizing.mjs';

/**
 * The run's sizing (Kanon plan 0012 §5.2, §5.3; harness #16): every number is derived from the
 * harness's settings, runner/settings.json, so a change of the jobs-at-once setting moves
 * max-parallel, the catalogue's cap and the janitor's cut-offs with it. The workflow test holds
 * e2e.yml's max-parallel and each job's timeout to these.
 */

const at = (over) => ({ ...SETTINGS, ...over, minutes: { ...SETTINGS.minutes, ...over?.minutes } });

describe('max-parallel, from the jobs-at-once setting (E0\'s item 5)', () => {
  it('holds the measured value, 6, and records where it came from', () => {
    expect(SETTINGS.jobsAtOnce).toBe(6);
    expect(SETTINGS.$sources.jobsAtOnce).toMatch(/item 5/);
  });

  it('is floor((6 − 1) / 2) = 2: a run\'s scenarios, each holding 2 jobs, fit the limit less the one job kept', () => {
    expect(maxParallel()).toBe(2);
    expect(maxParallel() * SETTINGS.jobsPerScenario).toBeLessThanOrEqual(SETTINGS.jobsAtOnce - SETTINGS.reservedJobs);
    expect((maxParallel() + 1) * SETTINGS.jobsPerScenario).toBeGreaterThan(SETTINGS.jobsAtOnce - SETTINGS.reservedJobs);
  });

  it('follows the setting: 20 jobs at once gives 9, 3 gives 1, and 2 leaves no room and says so', () => {
    expect(maxParallel(at({ jobsAtOnce: 20 }))).toBe(9);
    expect(maxParallel(at({ jobsAtOnce: 3 }))).toBe(1);
    expect(() => maxParallel(at({ jobsAtOnce: 2 }))).toThrow(/leaves no room/);
  });
});

describe('the longest running time, waves included (§5.2)', () => {
  it('is §5.2\'s 3 hours 20 minutes when every scenario runs at once', () => {
    expect(longestRunningMinutes(2)).toBe(10 + 10 + 3 * (25 + 35));
    expect(longestRunningMinutes(2)).toBe(200);
    // §5.2 counts the same 200 as three 50-minute phases plus 50 minutes of provision, the
    // model-key pair and the six phase mints.
    const m = stageMinutes();
    expect(m).toEqual({ provision: 10, modelKey: 10, kanon: 25, act: 35 });
  });

  it('grows with the waves a lower max-parallel makes', () => {
    expect(longestRunningMinutes(3)).toBe(2 * 10 + 10 + 3 * 2 * 60);
    expect(longestRunningMinutes(14)).toBe(7 * 10 + 10 + 3 * 7 * 60);
    expect(longestRunningMinutes(0)).toBe(0);
  });
});

describe('a run at the chosen max-parallel ends inside the nightly interval', () => {
  it('the catalogue\'s cap is the largest whose run fits the interval and whose repositories fit item 4', () => {
    const cap = maxScenarios();
    expect(cap).toBe(14);
    expect(longestRunningMinutes(cap)).toBeLessThanOrEqual(SETTINGS.nightlyIntervalHours * 60);
    expect(longestRunningMinutes(cap + 1)).toBeGreaterThan(SETTINGS.nightlyIntervalHours * 60);
    expect(repositoriesOf(cap)).toBeLessThanOrEqual(SETTINGS.reposPerHour);
  });

  it('item 4 binds when the jobs-at-once limit is generous', () => {
    const generous = at({ jobsAtOnce: 400 });
    expect(maxScenarios(generous)).toBe(40);
    expect(repositoriesOf(maxScenarios(generous))).toBe(SETTINGS.reposPerHour);
  });
});

describe('the janitor\'s cut-offs (§5.3)', () => {
  it('the cut-off is the longest running time the cap gives, plus the margin for queueing', () => {
    const { cutoffMinutes, failedCutoffMinutes } = janitorCutoffs();
    expect(cutoffMinutes).toBeGreaterThanOrEqual(longestRunningMinutes(maxScenarios()) + SETTINGS.queueMarginMinutes);
    expect(SETTINGS.queueMarginMinutes).toBe(100);
    expect(failedCutoffMinutes).toBeGreaterThanOrEqual(cutoffMinutes + 24 * 60);
    expect({ cutoffMinutes, failedCutoffMinutes }).toEqual({ cutoffMinutes: 1440, failedCutoffMinutes: 2880 });
  });

  it('follows the setting, not a constant: 20 jobs at once gives §5.2\'s full-parallelism figures', () => {
    const wide = at({ jobsAtOnce: 20 });
    const { cutoffMinutes } = janitorCutoffs(wide);
    expect(cutoffMinutes).toBe(longestRunningMinutes(maxScenarios(wide), wide) + 100);
    expect(cutoffMinutes).not.toBe(janitorCutoffs().cutoffMinutes);
  });

  it('sizing() reports every value the docs quote', () => {
    expect(sizing()).toEqual({
      jobsAtOnce: 6, maxParallel: 2, maxScenarios: 14, longestRunningMinutes: 1340,
      nightlyIntervalMinutes: 1440, cutoffMinutes: 1440, failedCutoffMinutes: 2880,
    });
  });
});
