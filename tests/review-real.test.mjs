import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateScenarioDir, validateScenarioJson } from '../runner/validate.mjs';
import { VOCABULARY } from '../runner/vocabulary.mjs';
import { REPO, context, stubGh, tempDir, writeTree } from './helpers/stubs.mjs';

/**
 * `review-real` (Kanon plan 0012 §6.2, step E10), the first real-model scenario, held to E10's
 * criteria as data, as the install family's tests hold theirs: install-review's install, a
 * one-line documentation pull request, the test Author's `review:please` (the `author-label` job,
 * the Owner's choice of 2026-10-20), and model-independent expectations only: the run completed,
 * the lane's row uploaded with its cost under the lane's ceiling, and a verdict posted by the
 * Judge, read by the Reviewer's role marker, never by its wording. Its last block runs the
 * scenario's own expectations on a reviewed run and on runs that must fail them.
 */

const ROOT = new URL('../', import.meta.url).pathname;
const load = (id) => {
  const dir = join(ROOT, 'scenarios', id);
  const read = (path) => readFileSync(join(dir, path), 'utf8');
  return { dir, read, scenario: JSON.parse(read('scenario.json')), phases: JSON.parse(read('steps.json')).phases };
};
const s = load('review-real');
const install = load('install-review');
const bare = ({ ...step }) => step;

describe('review-real', () => {
  it('validates', () => {
    expect(validateScenarioDir(s.dir)).toEqual([]);
  });

  it('scenario.json: family lane, the model tier on the subscription token, the Author and the Judge, gate: false, and the Author\'s label', () => {
    expect(s.scenario).toEqual({
      id: 'review-real', family: 'lane', tier: 'model', gate: false, apps: ['author', 'judge'], claude: 'subscription', deadlineMinutes: 120,
      authorLabel: { head: 'docs-note', label: 'review:please' },
    });
  });

  it('phase 1 is install-review\'s install, with the caller mapping the subscription token, then a pull request from the label\'s branch', () => {
    const [p1] = s.phases;
    expect(p1.kanon[0].flags).toEqual([...install.phases[0].kanon[0].flags.slice(0, 2), '--claude-auth=subscription', ...install.phases[0].kanon[0].flags.slice(2)]);
    expect(p1.kanon.slice(1)).toEqual(install.phases[0].kanon.slice(1));
    expect(p1.act.slice(0, install.phases[0].act.length)).toEqual(install.phases[0].act);
    const rest = p1.act.slice(install.phases[0].act.length);
    expect(rest.map((x) => x.verb)).toEqual(['files.commit', 'pr.open', 'run.await']);
    expect(rest[1]).toMatchObject({ name: 'note', head: s.scenario.authorLabel.head });
    // CI on the pull request completes before the Author labels it, so the label isn't deferred.
    expect(rest[2]).toMatchObject({ workflow: 'ci.yml', event: 'pull_request', pr: 'note' });
    expect(s.read('change/docs/note.md').split('\n').filter((l) => l && !l.startsWith('#'))).toHaveLength(1);
  });

  it('no step labels the pull request as the driver: the Author does, between phase 1 and phase 2', () => {
    expect(s.phases.flatMap((p) => [...p.kanon, ...p.act]).filter((x) => x.verb === 'pr.label')).toEqual([]);
  });

  it('phase 2 waits for the run the Author\'s label started, whatever other label runs exist; phase 3 holds the row first, so its cost is kept whatever the run did, reading the review job when there is none, so a refused label fails first as a refusal; then the run and the verdict', () => {
    expect(s.phases[1].kanon).toEqual([]);
    expect(s.phases[1].act).toEqual([{ verb: 'run.await', name: 'review', workflow: 'agent-review.yml', event: 'pull_request_target', pr: 'note', actor: 'author', deadline: 25 }]);
    expect(s.phases[2].act.map((x) => x.verb)).toEqual(['expect.row', 'expect.run', 'expect.pr']);
    expect(s.phases[2].act[0]).toEqual({ verb: 'expect.row', run: 'review', lane: 'review', job: 'review / review', ceilingUsd: 30, deadline: 5 });
    expect(s.phases[2].act[2]).toEqual({ verb: 'expect.pr', pr: 'note', marker: 'role:reviewer', markerBy: 'kanon-e2e-judge', deadline: 5 });
  });

  it('has a README in the house style, naming plan 0012 step E10, its gate: false and who applies the label', () => {
    const readme = s.read('README.md');
    for (const heading of ['Who applies the label', 'What the repository holds', 'The flags', 'The steps', 'What it creates', 'What it costs', 'When it is red']) expect(readme).toMatch(new RegExp(`^## ${heading}`, 'm'));
    expect(readme).toContain('Kanon\'s plan 0012 step E10');
    expect(readme).toContain('`gate: false`');
  });
});

describe('`authorLabel` in scenario.json', () => {
  const base = { id: 'x', family: 'lane', tier: 'model', gate: false, apps: ['author', 'judge'], claude: 'subscription', deadlineMinutes: 60 };

  it('takes exactly a branch and a label, for a real-model scenario that lists the Author', () => {
    expect(validateScenarioJson({ ...base, authorLabel: { head: 'docs-note', label: 'review:please' } }, 'x')).toEqual([]);
    for (const [over, re] of [
      [{ authorLabel: { head: 'docs-note' } }, /exactly `head` and `label`/],
      [{ authorLabel: { head: '../x', label: 'review:please' } }, /not a branch/],
      [{ authorLabel: { head: 'b', label: 'Review Please' } }, /must match/],
      [{ apps: ['judge'], authorLabel: { head: 'b', label: 'review:please' } }, /doesn't list `author`/],
      [{ claude: 'none', tier: 'none', authorLabel: { head: 'b', label: 'review:please' } }, /real-model scenario/],
    ]) expect(validateScenarioJson({ ...base, ...over }, 'x').join('\n')).toMatch(re);
  });

  it('needs phase 1 to open the pull request from its branch, and a phase 2', () => {
    const dir = join(tempDir('label-'), 'x');
    const write = (steps) => writeTree(dir, { 'scenario.json': JSON.stringify({ ...base, authorLabel: { head: 'docs-note', label: 'review:please' } }), 'start/README.md': 'x', 'steps.json': JSON.stringify(steps) });
    const p1 = { kanon: [], act: [{ verb: 'files.commit', from: 'scenario', dir: 'start', branch: 'other', message: 'm' }, { verb: 'pr.open', name: 'n', head: 'other', title: 't' }] };
    write({ phases: [p1, { kanon: [], act: [{ verb: 'expect.pr', pr: 'n', state: 'open', deadline: 1 }] }] });
    expect(validateScenarioDir(dir).join('\n')).toMatch(/opens none from it/);
    write({ phases: [{ ...p1, act: [p1.act[0], { ...p1.act[1], head: 'docs-note' }] }] });
    expect(validateScenarioDir(dir).join('\n')).toMatch(/needs a phase 2/);
  });
});

describe('review-real\'s expectations on a reviewed run, and on runs that must fail them', () => {
  const fails = { name: 'Fail' };
  const RUN = 7;
  const runOf = (conclusion, jobs) => stubGh({
    [`GET repos/${REPO}/actions/runs/${RUN}`]: { id: RUN, status: 'completed', conclusion },
    [`GET repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100`]: { jobs: jobs.map(([name, c], i) => ({ id: 100 + i, name, conclusion: c })) },
  }).gh;
  const [row, run, verdict] = s.phases[2].act;
  const holdRun = (gh) => VOCABULARY['expect.run'].run(bare(run), context({ gh, state: { runs: { review: RUN } } }));
  const prOf = (reviews) => stubGh({
    [`GET repos/${REPO}/pulls/4`]: { state: 'open', merged: false, labels: [{ name: 'review:please' }], user: { login: 'kanon-e2e-driver[bot]' }, body: '' },
    [`GET repos/${REPO}/issues/4/comments?per_page=100`]: [[]],
    [`GET repos/${REPO}/pulls/4/reviews?per_page=100`]: [reviews],
  }).gh;
  const holdVerdict = (gh) => VOCABULARY['expect.pr'].run(bare({ ...verdict, deadline: 1 }), context({ gh, state: { prs: { note: 4 } } }));

  it('phase 2 keeps the run the Author\'s label started, though the Reviewer\'s own labels start newer, quickly skipped runs on the same head (harness #104)', async () => {
    const [awaited] = s.phases[1].act;
    const by = (login, id, status, conclusion) => ({ id, run_number: id, status, conclusion, triggering_actor: { login } });
    const listing = `GET repos/${REPO}/actions/workflows/agent-review.yml/runs?event=pull_request_target&head_sha=abc&per_page=20`;
    const g = stubGh({
      [`GET repos/${REPO}/pulls/4`]: { head: { sha: 'abc' } },
      [listing]: { workflow_runs: [
        by('kanon-e2e-driver[bot]', 1, 'completed', 'skipped'),
        by('kanon-e2e-author[bot]', 2, 'completed', 'success'),
        by('kanon-e2e-judge[bot]', 3, 'completed', 'skipped'),
        by('kanon-e2e-judge[bot]', 4, 'completed', 'skipped'),
      ] },
    });
    const ctx = context({ gh: g.gh, state: { prs: { note: 4 } } });
    await VOCABULARY['run.await'].run(bare(awaited), ctx);
    expect(ctx.state.runs.review).toBe(2);
  });

  it('the row: a run whose gate refused the label (`review / review` skipped) fails at once, saying the job was skipped, not at the row\'s deadline (harness #105)', async () => {
    const { gh } = stubGh({
      [`GET repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`]: { artifacts: [] },
      [`GET repos/${REPO}/actions/runs/${RUN}/jobs?per_page=100`]: { jobs: [{ id: 1, name: 'review / filter', conclusion: 'success' }, { id: 2, name: 'review / notify-unlabeled', conclusion: 'skipped' }, { id: 3, name: 'review / review', conclusion: 'skipped' }] },
    });
    const ctx = context({ gh, state: { runs: { review: RUN } } });
    const start = ctx.now();
    await expect(VOCABULARY['expect.row'].run(bare(row), ctx)).rejects.toMatchObject({ ...fails, message: expect.stringMatching(/job `review \/ review` was skipped/) });
    expect(ctx.now()).toBe(start);
  });

  it('the run: passes when the review ran; fails when the gate refused the label, or the agent failed', async () => {
    await holdRun(runOf('success', [['review / filter', 'success'], ['review / notify-unlabeled', 'skipped'], ['review / review', 'success']]));
    await expect(holdRun(runOf('success', [['review / filter', 'success'], ['review / notify-unlabeled', 'skipped'], ['review / review', 'skipped']]))).rejects.toMatchObject(fails);
    await expect(holdRun(runOf('failure', [['review / filter', 'success'], ['review / review', 'failure']]))).rejects.toMatchObject(fails);
  });

  it('the verdict: either kind, by the Judge\'s role marker; not another App\'s, and not none', async () => {
    for (const body of ['**Reviewer** <!-- kanon:role=reviewer -->\nApproved.', '**Reviewer** <!-- kanon:role=reviewer -->\nChanges requested.']) {
      await holdVerdict(prOf([{ body, user: { login: 'kanon-e2e-judge[bot]' } }]));
    }
    await expect(holdVerdict(prOf([{ body: '<!-- kanon:role=reviewer -->', user: { login: 'kanon-e2e-author[bot]' } }]))).rejects.toMatchObject(fails);
    await expect(holdVerdict(prOf([]))).rejects.toMatchObject(fails);
  });
});
