import { describe, expect, it } from 'vitest';
import { maxParallel, SETTINGS } from '../runner/sizing.mjs';
import { readWorkflows, workflowText } from './helpers/workflows.mjs';

/**
 * The end-to-end workflows' shape (Kanon plan 0012 §5.2, §5.3, §7; harness #16): `e2e.yml`'s jobs,
 * their order and conditions; each pair, a `mint` that holds the key and a job handed only the
 * token; the `kanon` token read-only (decision 23 (b)); the `act` job running no Kanon code; and
 * the sizing and the timeouts held to runner/settings.json.
 */

const docs = readWorkflows();
const e2e = docs['e2e.yml'];
const PAIRS = ['kanon', 'act', 'model-key', 'janitor'];
const TOKEN_ACTION = /^actions\/create-github-app-token@[0-9a-f]{40}$/;
const SCENARIO_JOBS = ['kanon-1', 'act-1', 'kanon-2', 'act-2', 'kanon-3', 'act-3'];
const GATES = ['gate-2', 'gate-3'];
const RUNS_IF = "${{ !cancelled() && needs.start.result != 'failure' && needs.plan.outputs.go == 'true' }}";
/** Phase 2's and 3's scenario jobs run only the scenarios their gate kept, and only when it kept one (#62). */
const GATED_IF = (gate) => `\${{ !cancelled() && needs.start.result != 'failure' && needs.plan.outputs.go == 'true' && needs.${gate}.result == 'success' && needs.${gate}.outputs.scenarios != '[]' }}`;
const gateOf = (name) => (Number(name.split('-')[1]) > 1 ? `gate-${name.split('-')[1]}` : null);
const only = (o) => Object.values(o.jobs)[0];
const mintOf = (pair) => docs[`e2e-${pair}-run.yml`].jobs.mint.steps.find((s) => TOKEN_ACTION.test(s.uses ?? ''));
const permissionsOf = (step) => Object.fromEntries(Object.entries(step.with).filter(([k]) => k.startsWith('permission-')).map(([k, v]) => [k.slice('permission-'.length), v]));

describe('e2e.yml: its triggers, never a pull request (§7)', () => {
  it('runs on the poll\'s and the nightly\'s schedules, as runner/settings.json holds them, and on a dispatch of an exact release', () => {
    expect(Object.keys(e2e.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(e2e.on.schedule.map((s) => s.cron)).toEqual([SETTINGS.schedules.poll, SETTINGS.schedules.nightly]);
    expect(e2e.on.workflow_dispatch.inputs.release).toMatchObject({ required: true, type: 'string' });
    expect(Object.keys(e2e.on.workflow_dispatch.inputs).sort()).toEqual(['release', 'select']);
  });

  it('has no permissions of its own, and one concurrency group per release or schedule, from `github` and `inputs` only, never cancelling', () => {
    expect(e2e.permissions).toEqual({});
    expect(e2e.concurrency['cancel-in-progress']).toBe(false);
    const contexts = [...e2e.concurrency.group.matchAll(/\b([a-z_]+)\.[a-z_.]+/g)].map((m) => m[1]);
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((c) => ['github', 'inputs'].includes(c))).toBe(true);
    expect(e2e.concurrency.group).toBe('e2e-${{ inputs.release || github.event.schedule }}');
  });

  it('the poll and the nightly sit in different groups, so a queued nightly isn\'t replaced by the next poll', () => {
    const group = (inputs, schedule) => e2e.concurrency.group.replace(/\$\{\{ inputs\.release \|\| github\.event\.schedule \}\}/, inputs.release || schedule);
    const poll = group({}, SETTINGS.schedules.poll);
    const nightly = group({}, SETTINGS.schedules.nightly);
    expect(poll).not.toBe(nightly);
    expect(group({ release: 'v0.41.0' }, '')).not.toBe(poll);
  });
});

describe('e2e.yml: the jobs of §5.2, in order', () => {
  it('holds exactly plan, start, provision, model-key, the six scenario jobs with a gate before phases 2 and 3, verdict and report', () => {
    expect(Object.keys(e2e.jobs)).toEqual(['plan', 'start', 'provision', 'model-key', 'kanon-1', 'act-1', 'gate-2', 'kanon-2', 'act-2', 'gate-3', 'kanon-3', 'act-3', 'verdict', 'report']);
  });

  it('`plan` reads with the workflow\'s own token only, and records its marker before any repository is created', () => {
    expect(e2e.jobs.plan.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(e2e.jobs.plan.environment).toBeUndefined();
    const upload = e2e.jobs.plan.steps.find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
    expect(upload).toMatchObject({ if: "steps.plan.outputs.go == 'true'", with: { name: '${{ steps.plan.outputs.marker }}' } });
    expect(upload.with['retention-days']).toBeGreaterThanOrEqual(SETTINGS.nightlyFloorDays + 1);
    expect(e2e.jobs.start.needs).toBe('plan');
    expect(e2e.jobs.provision.needs).toEqual(['plan', 'start']);
  });

  it('`start` posts the check run only for a candidate\'s run that goes ahead', () => {
    expect(e2e.jobs.start.if).toBe("${{ needs.plan.outputs.go == 'true' && needs.plan.outputs.trigger == 'candidate' }}");
  });

  it('every scenario job runs unless the run was cancelled, `start` failed or `plan` said no; each needs the one before', () => {
    expect(e2e.jobs.provision.if).toBe(RUNS_IF);
    for (const name of ['provision', 'model-key']) expect(e2e.jobs[name].needs, name).toEqual(expect.arrayContaining(['plan', 'start']));
    expect(e2e.jobs['model-key'].if).toBe("${{ !cancelled() && needs.start.result != 'failure' && needs.plan.outputs.go == 'true' && needs.plan.outputs.model-scenarios != '[]' }}");
    const before = { 'kanon-1': 'model-key', 'act-1': 'kanon-1', 'gate-2': 'act-1', 'kanon-2': 'gate-2', 'act-2': 'kanon-2', 'gate-3': 'act-2', 'kanon-3': 'gate-3', 'act-3': 'kanon-3' };
    for (const name of GATES) {
      expect(e2e.jobs[name].if, name).toBe(RUNS_IF);
      expect(e2e.jobs[name].needs, name).toEqual(expect.arrayContaining(['plan', 'start', before[name]]));
    }
    for (const name of SCENARIO_JOBS) {
      const job = e2e.jobs[name];
      const gate = gateOf(name);
      expect(job.if, name).toBe(gate ? GATED_IF(gate) : RUNS_IF);
      expect(job.needs, name).toEqual(expect.arrayContaining(['plan', 'start', before[name], ...(gate ? [gate] : [])]));
      expect(job.strategy.matrix.scenario, name).toBe(gate ? `\${{ fromJSON(needs.${gate}.outputs.scenarios) }}` : '${{ fromJSON(needs.plan.outputs.scenarios) }}');
      const [kind, phase] = name.split('-');
      expect(job.uses, name).toBe(`./.github/workflows/e2e-${kind}-run.yml`);
      expect(job.with.phase, name).toBe(Number(phase));
      expect(job.with['repository-name'], name).toBe('e2e-${{ matrix.scenario.id }}-${{ github.run_id }}-${{ github.run_attempt }}');
      expect(job.secrets, name).toEqual({ DRIVER_APP_ID: '${{ secrets.DRIVER_APP_ID }}', DRIVER_APP_KEY: '${{ secrets.DRIVER_APP_KEY }}' });
    }
  });

  it('a phase-N job neither mints nor runs for a scenario with fewer than N phases, or one an earlier phase ended (#62)', () => {
    for (const gate of GATES) {
      const job = e2e.jobs[gate];
      const phase = gate.split('-')[1];
      expect(job.environment, gate).toBeUndefined();
      expect(job.permissions, gate).toEqual({ contents: 'read' });
      expect(JSON.stringify(job), gate).not.toMatch(/secrets\./);
      expect(job['timeout-minutes'], gate).toBe(SETTINGS.minutes.gate);
      expect(job.outputs.scenarios, gate).toBe('${{ steps.gate.outputs.scenarios }}');
      const download = job.steps.find((s) => String(s.uses).startsWith('actions/download-artifact@'));
      expect(download, gate).toMatchObject({ 'continue-on-error': true, with: { pattern: 'kanon-e2e-result-*', path: '${{ runner.temp }}/results' } });
      const decide = job.steps.find((s) => s.id === 'gate');
      expect(decide.run, gate).toBe('node runner/gate.mjs');
      expect(decide.env, gate).toMatchObject({ PHASE: Number(phase), SCENARIOS: '${{ needs.plan.outputs.scenarios }}', RESULTS_DIR: download.with.path });
      // Both of the phase's jobs, and so both of its mints, take their scenarios from the gate.
      for (const name of [`kanon-${phase}`, `act-${phase}`]) {
        expect(e2e.jobs[name].strategy.matrix.scenario, name).toBe(`\${{ fromJSON(needs.${gate}.outputs.scenarios) }}`);
        expect(e2e.jobs[name].if, name).toBe(GATED_IF(gate));
      }
    }
  });

  it('`verdict` waits for every scenario job and runs unless cancelled; `report` runs whenever `start` posted a check run', () => {
    expect(e2e.jobs.verdict.needs).toEqual(expect.arrayContaining(['plan', 'start', 'provision', 'model-key', ...SCENARIO_JOBS, ...GATES]));
    expect(e2e.jobs.verdict.if).toBe("${{ !cancelled() && needs.plan.outputs.go == 'true' }}");
    expect(e2e.jobs.report.needs).toEqual(['plan', 'start', 'verdict']);
    expect(e2e.jobs.report.if).toBe("${{ always() && needs.start.result == 'success' }}");
  });

  it('the jobs that hold a key run nothing but the token action and `gh`: no checkout, no harness code', () => {
    for (const name of ['start', 'provision', 'report']) {
      for (const s of e2e.jobs[name].steps) {
        if (s.uses) expect(s.uses, `${name}: ${s.uses}`).toMatch(/^actions\/(create-github-app-token|download-artifact)@[0-9a-f]{40}$/);
        else expect(s.run, name).not.toMatch(/\bnode\b|\bnpx\b|\bnpm\b|runner\//);
      }
    }
  });

  it('`provision` writes only the Apps the scenario lists, under the names Kanon\'s callers map', () => {
    const write = e2e.jobs.provision.steps.find((s) => s.name === 'Write the scenario\'s test Apps\' secrets');
    for (const app of ['author', 'judge', 'releaser']) {
      const upper = app.toUpperCase();
      expect(write.env[`${upper}_ID`]).toBe(`\${{ contains(matrix.scenario.apps, '${app}') && secrets.${upper}_APP_ID || '' }}`);
      expect(write.env[`${upper}_KEY`]).toBe(`\${{ contains(matrix.scenario.apps, '${app}') && secrets.${upper}_APP_KEY || '' }}`);
    }
    expect(write.run).toMatch(/_APP_PRIVATE_KEY/);
    expect(JSON.stringify(e2e.jobs.provision)).not.toMatch(/CLAUDE|OAUTH|ANTHROPIC/i);
    expect(e2e.jobs.provision.steps.at(-1).run).toMatch(/kanon-e2e-provisioned/);
  });
});

describe('the sizing and the timeouts follow runner/settings.json', () => {
  it('every matrix runs at maxParallel(), with fail-fast off, and says where the number comes from', () => {
    const matrixJobs = Object.entries(e2e.jobs).filter(([, j]) => j.strategy);
    expect(matrixJobs.map(([n]) => n)).toEqual(['provision', 'model-key', ...SCENARIO_JOBS]);
    for (const [name, job] of matrixJobs) {
      expect(job.strategy['max-parallel'], name).toBe(maxParallel());
      expect(job.strategy['fail-fast'], name).toBe(false);
    }
    const lines = workflowText('e2e.yml').split('\n').filter((l) => /max-parallel:/.test(l));
    expect(lines).toHaveLength(matrixJobs.length);
    for (const l of lines) expect(l).toMatch(/# maxParallel\(\) in runner\/sizing\.mjs/);
  });

  it('each job\'s timeout-minutes is the setting\'s', () => {
    expect(e2e.jobs.provision['timeout-minutes']).toBe(SETTINGS.minutes.provision);
    for (const pair of PAIRS) expect(docs[`e2e-${pair}-run.yml`].jobs.mint['timeout-minutes'], pair).toBe(SETTINGS.minutes.mint);
    expect(only(docs['e2e-model-key-job.yml'])['timeout-minutes']).toBe(SETTINGS.minutes.modelKey);
    expect(only(docs['e2e-kanon-job.yml'])['timeout-minutes']).toBe(SETTINGS.minutes.kanon);
    expect(only(docs['e2e-act-job.yml'])['timeout-minutes']).toBe(SETTINGS.minutes.act);
  });
});

describe('each pair: a `mint` that holds the key, and a job handed only the token (Kanon\'s spine)', () => {
  for (const pair of PAIRS) {
    it(`e2e-${pair}-run.yml mints in \`e2e\`, seals, and calls its job with the token`, () => {
      const run = docs[`e2e-${pair}-run.yml`];
      expect(Object.keys(run.jobs)).toEqual(['mint', 'job']);
      const { mint, job } = run.jobs;
      expect(mint.environment).toBe('e2e');
      expect(mint.permissions).toEqual({});
      expect(mint.steps).toHaveLength(2);
      expect(mint.steps[0].uses).toMatch(TOKEN_ACTION);
      expect(mint.steps[0].with).toMatchObject({ 'app-id': '${{ secrets.DRIVER_APP_ID }}', 'private-key': '${{ secrets.DRIVER_APP_KEY }}', owner: 'kanon-e2e', 'skip-token-revoke': 'true' });
      expect(mint.steps[1].run).toMatch(/od -An -v -tx1/);
      expect(mint.outputs.attempt).toBe('${{ github.run_attempt }}');
      expect(job).toMatchObject({ needs: 'mint', if: '${{ !cancelled() }}', uses: `./.github/workflows/e2e-${pair}-job.yml` });
      expect(job.with['mint-attempt']).toBe('${{ needs.mint.outputs.attempt }}');
      expect(job.secrets['app-token']).toBe('${{ needs.mint.outputs.sealed }}');
      expect(Object.keys(run.on.workflow_call.secrets)).toEqual(expect.arrayContaining(['DRIVER_APP_ID', 'DRIVER_APP_KEY']));
    });

    it(`e2e-${pair}-job.yml is one job: it receives the token first, refusing an earlier attempt's, and revokes it last, always`, () => {
      const doc = docs[`e2e-${pair}-job.yml`];
      expect(Object.keys(doc.jobs)).toHaveLength(1);
      const steps = only(doc).steps;
      expect(steps[0]).toMatchObject({ name: 'Receive the App token', id: 'app-token' });
      expect(steps[0].run).toMatch(/MINT_ATTEMPT" != "\$RUN_ATTEMPT/);
      expect(steps[0].run).toMatch(/::add-mask::/);
      expect(steps.at(-1)).toMatchObject({ name: 'Revoke the App token', if: '${{ always() }}' });
      expect(steps.at(-1).run).toMatch(/-X DELETE[\s\S]*\/installation\/token/);
      const reading = steps.filter((s) => JSON.stringify(s).includes('secrets.app-token'));
      expect(reading).toEqual([steps[0], steps.at(-1)]);
      expect(doc.on.workflow_call.secrets['app-token'].required).toBe(true);
    });
  }

  it('the `kanon` token is read-only: no write, no Workflows, no Secrets (decision 23 (b))', () => {
    const perms = permissionsOf(mintOf('kanon'));
    expect(perms).toEqual({ contents: 'read', issues: 'read', 'pull-requests': 'read', actions: 'read', administration: 'read' });
    expect(mintOf('kanon').with.repositories).toBe('${{ inputs.repository-name }}');
  });

  it('the `act` token is scoped to the one repository, with what pushing, merging, `repo.apply` and ending it take', () => {
    expect(mintOf('act').with.repositories).toBe('${{ inputs.repository-name }}');
    expect(permissionsOf(mintOf('act'))).toEqual({
      contents: 'write', workflows: 'write', issues: 'write', 'pull-requests': 'write', actions: 'write', administration: 'write', secrets: 'read', checks: 'read',
    });
  });

  it('the model-key token writes secrets only, to the one repository; the janitor\'s deletes across the organisation', () => {
    expect(permissionsOf(mintOf('model-key'))).toEqual({ secrets: 'write' });
    expect(mintOf('model-key').with.repositories).toBe('${{ inputs.repository-name }}');
    expect(permissionsOf(mintOf('janitor'))).toEqual({ administration: 'write' });
  });
});

describe('the `kanon` and `act` jobs (§5.2)', () => {
  const kanon = only(docs['e2e-kanon-job.yml']);
  const act = only(docs['e2e-act-job.yml']);
  const runStep = (job) => job.steps.find((s) => s.run === 'node runner/run.mjs');

  it('the `kanon` job runs the kanon segment with the read-only token, and uploads its tree and its state', () => {
    expect(runStep(kanon).env).toMatchObject({ SEGMENT: 'kanon', GH_TOKEN: '${{ steps.app-token.outputs.token }}' });
    const tree = kanon.steps.find((s) => s.with?.name === 'e2e-tree-${{ inputs.scenario }}-kanon-${{ inputs.phase }}');
    expect(tree.with).toMatchObject({ path: '${{ runner.temp }}/e2e/work/clone', 'include-hidden-files': true });
    expect(kanon.steps.some((s) => s.with?.name === 'e2e-state-${{ inputs.scenario }}-kanon-${{ inputs.phase }}')).toBe(true);
  });

  it('the `act` job runs no Kanon code: the act segment only, and nothing that fetches or runs Kanon', () => {
    expect(runStep(act).env).toMatchObject({ SEGMENT: 'act' });
    const text = workflowText('e2e-act-job.yml');
    expect(text).not.toMatch(/\bnpx\b|\bnpm\b|yedeya-labs\/kanon/);
    for (const s of act.steps) if (s.run) expect(s.run).toMatch(/^node runner\/run\.mjs$|Receive|App token|curl/);
  });

  it('the `act` job unpacks the tree into a scratch directory, which only the runner reads, as data', () => {
    const download = act.steps.find((s) => s.with?.name === 'e2e-tree-${{ inputs.scenario }}-kanon-${{ inputs.phase }}');
    expect(download.with.path).toBe('${{ runner.temp }}/e2e/scratch');
    expect(runStep(act).env.TREE_DIR).toBe(download.with.path);
    expect(runStep(act).env.WORK).not.toContain('scratch');
  });

  it('the `act` job uploads the result only when it finalized the scenario', () => {
    const upload = act.steps.find((s) => s.with?.name === 'kanon-e2e-result-${{ inputs.scenario }}');
    expect(upload.if).toBe("${{ always() && steps.run.outputs.finalized == 'true' }}");
  });

  it('the model-key job is three steps in `e2e-model`: receive, write the token, revoke; only the second reads the model token', () => {
    const job = only(docs['e2e-model-key-job.yml']);
    expect(job.environment).toBe('e2e-model');
    expect(job.steps).toHaveLength(3);
    expect(job.steps.filter((s) => JSON.stringify(s).includes('E2E_CLAUDE_CODE_OAUTH_TOKEN'))).toEqual([job.steps[1]]);
    expect(job.steps[1].run).toMatch(/gh secret set CLAUDE_CODE_OAUTH_TOKEN/);
  });
});

describe('the janitor\'s workflow (§5.3)', () => {
  it('runs hourly and on a dispatch, through its pair, and runs janitor/janitor.mjs', () => {
    const w = docs['e2e-janitor.yml'];
    expect(w.on.schedule).toEqual([{ cron: expect.stringMatching(/^\d{1,2} \* \* \* \*$/) }]);
    expect(Object.keys(w.on)).toEqual(['schedule', 'workflow_dispatch']);
    expect(w.jobs.janitor.uses).toBe('./.github/workflows/e2e-janitor-run.yml');
    expect(only(docs['e2e-janitor-job.yml']).steps.some((s) => s.run === 'node janitor/janitor.mjs')).toBe(true);
  });
});

describe('every action the e2e workflows use is pinned to a commit', () => {
  it('holds for each e2e*.yml', () => {
    const unpinned = Object.entries(docs).filter(([f]) => f.startsWith('e2e')).flatMap(([f, d]) => Object.values(d.jobs).flatMap((j) => (j.steps ?? [])
      .filter((s) => s.uses && !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(s.uses)).map((s) => `${f}: ${s.uses}`)));
    expect(unpinned).toEqual([]);
  });
});
