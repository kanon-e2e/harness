import { describe, expect, it } from 'vitest';
import { environmentJobs, environmentOf, readWorkflows, workflowFiles, workflowText } from './helpers/workflows.mjs';

/**
 * The harness's workflow test (Kanon plan 0012 §5.2 and §11). Kanon's
 * `tests/unit/app-key-isolation.test.ts` holds `K-AGENT-49` for Kanon's own workflows only, so
 * the harness copies its assertions and runs them on its own:
 *
 *   • no job that holds an App's key runs someone else's code (the copy of Kanon's check);
 *   • each environment is named only by the jobs §5.2 lists;
 *   • no `-job` workflow names a private key: it is handed a token, never a key;
 *   • no workflow runs on `pull_request`, `pull_request_target` or `merge_group` with a secret.
 *
 * THE HARNESS'S KEYS HAVE THEIR OWN NAMES. The environments hold `DRIVER_APP_KEY`,
 * `RELEASER_APP_KEY` and `REPORTER_APP_KEY`, which Kanon's pattern (`…PRIVATE_KEY`) doesn't
 * match, so `KEY` matches both spellings.
 */

const docs = readWorkflows();
const files = workflowFiles();

/** A reference to an App key: `secrets.X_PRIVATE_KEY`, `secrets.X_APP_KEY`, `secrets.app-private-key`, or a computed `secrets[…]` naming one. */
const KEY = /secrets\s*(?:\.\s*[\w-]*(?:private|app)[-_]key\b|\[[^\]]*(?:private|app)[-_]key[^\]]*\])/i;
const holdsKey = (job) => KEY.test(JSON.stringify(job));
/** A `secrets.` reference of any name, the whole context, or `secrets: inherit` (as JSON). */
const SECRET = /\bsecrets\s*(?:\.|\[)|toJSON\(\s*secrets\s*\)|"secrets":"inherit"/;

// ── The copy of Kanon's check (`K-AGENT-49`) ────────────────────────────────────────────────

const isAgent = (s) => /(^|\/)actions\/agent-run(@|$)/.test(String(s.uses ?? '')) || String(s.uses ?? '').startsWith('anthropics/claude-code-action');
const isLocal = (s) => String(s.uses ?? '').startsWith('./');
const isNotify = (s) => /^(?:\$\/|yedeya-labs\/kanon\/)actions\/notify(?:@|$)/.test(String(s.uses ?? ''));
const DEFAULT_BRANCH = /^\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}$/;
const isRefCheckout = (s) => String(s.uses ?? '').startsWith('actions/checkout@')
  && String(s.with?.ref ?? '') !== '' && !DEFAULT_BRANCH.test(String(s.with?.ref));
/** Why a job runs code other than its own, or `undefined` when it runs none. */
const runsOthersCode = (job) => {
  const steps = job.steps ?? [];
  if (steps.some(isAgent)) return 'runs the agent';
  const local = steps.find(isLocal);
  if (local) return `runs \`${local.uses}\` from the checkout`;
  if (steps.some(isNotify)) return 'runs the notify hook from the checkout';
  if (steps.some(isRefCheckout)) return 'checks out a ref other than the triggering commit';
  return undefined;
};
/** Every `file:job` that both holds a key and runs someone else's code, with why. */
const violations = (all) =>
  Object.fromEntries(Object.entries(all).flatMap(([f, doc]) => Object.entries(doc?.jobs ?? {}).flatMap(([name, job]) => {
    const why = runsOthersCode(job);
    return why && holdsKey(job) ? [[`${f}:${name}`, why]] : [];
  })));

// ── Which jobs may name an environment ───────────────────────────────────────────────────────

/**
 * Plan 0012 §5.2's jobs, each with the one environment it may name. `*` stands for a workflow's
 * one job, whose name §5.2 doesn't fix: such a file must hold exactly one job. Nothing else may
 * name an environment, and no job here may name another. E0's probes named `e2e` and
 * `e2e-report` too, until they were retired (#7): a probe added again must be listed here.
 */
const ALLOWED = [
  // `e2e.yml`: `start` and `report` mint the Reporter's token; `provision` the driver's.
  ['e2e.yml', 'start', 'e2e-report'],
  ['e2e.yml', 'provision', 'e2e'],
  ['e2e.yml', 'report', 'e2e-report'],
  // Each pair's `mint`.
  ['e2e-kanon-run.yml', 'mint', 'e2e'],
  ['e2e-act-run.yml', 'mint', 'e2e'],
  ['e2e-janitor-run.yml', 'mint', 'e2e'],
  ['e2e-model-key-run.yml', 'mint', 'e2e'],
  // E10 (the Owner, 2026-10-20): the Author's key, for the label a model lane's gate admits.
  ['e2e-author-label-run.yml', 'mint', 'e2e'],
  // The one job that writes the real-model key.
  ['e2e-model-key-job.yml', '*', 'e2e-model'],
];

/** Every `file:job` naming an environment it may not, with the environment. */
const strayEnvironments = (all) => environmentJobs(all).flatMap(({ file, job, environment }) => {
  const allowed = ALLOWED.some(([f, j, env]) => f === file && env === environment
    && (j === job || (j === '*' && Object.keys(all[file]?.jobs ?? {}).length === 1)));
  return allowed ? [] : [`${file}:${job} names \`${environment}\``];
});

// ── `-job` workflows ─────────────────────────────────────────────────────────────────────────

/** A workflow handed a token by its pair's `-run` (§5.2's third level). */
const isJobWorkflow = (f) => /-job\.ya?ml$/.test(f);
/** Every `-job` workflow that names a private key: by a secret's name, or as a `private-key:` input. */
const keyedJobWorkflows = (texts) => Object.entries(texts)
  .filter(([f, text]) => isJobWorkflow(f) && (KEY.test(text) || /^\s*private[-_]key\s*:/im.test(text)))
  .map(([f]) => f);

// ── Pull-request triggers ────────────────────────────────────────────────────────────────────

const PR_EVENTS = ['pull_request', 'pull_request_target', 'merge_group'];
/** The events a workflow runs on. `on:` is a name, a list, or a map. */
const eventsOf = (doc) => {
  const on = doc?.on ?? doc?.true; // YAML 1.1 reads a bare `on` as true; `yaml` reads 1.2, but be safe.
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === 'object' ? Object.keys(on) : [];
};

/**
 * KANON'S OWN LANE CALLERS ARE THE ONE EXCEPTION. The harness adopts Kanon's full pipeline
 * (plan 0012 §3, decisions 17 and 20), and `kanon init` writes the review, revise, reconcile and
 * rebase callers on pull-request events, mapping the test Apps' repository secrets by name into
 * a call of Kanon's lane at a pinned release. What those lanes do with them is Kanon's to hold
 * (`K-AGENT-47`: a fork's pull request gets no secret; `K-AGENT-49` in Kanon's own test), and
 * `lane-check` holds each caller to its lane on every pull request. So a job is let through
 * only when it is exactly that: a call of `yedeya-labs/kanon/.github/workflows/<lane>@<ref>`
 * whose secrets are each mapped by its own name, with no step, no `env:` and no environment,
 * and no secret anywhere else in the workflow. Everything else the harness writes (the e2e
 * workflows, CI) gets no secret on these events at all.
 */
const KANON_LANE = /^yedeya-labs\/kanon\/\.github\/workflows\/[\w.-]+\.ya?ml@[\w.-]+$/;
const isKanonLaneCall = (job) => {
  if (!KANON_LANE.test(String(job?.uses ?? ''))) return false;
  if (job.steps !== undefined || job.env !== undefined || job.environment !== undefined) return false;
  const secrets = job.secrets ?? {};
  if (typeof secrets !== 'object') return false; // `secrets: inherit`
  return Object.entries(secrets).every(([k, v]) => v === `\${{ secrets.${k} }}`);
};
/** Every workflow that runs on a pull-request event and reads a secret outside a Kanon lane call. */
const secretsOnPullRequests = (all) => Object.entries(all).flatMap(([f, doc]) => {
  const events = eventsOf(doc).filter((e) => PR_EVENTS.includes(e));
  if (!events.length) return [];
  const { jobs = {}, on: _on, ...rest } = doc ?? {};
  const where = [
    ...(SECRET.test(JSON.stringify(rest)) ? ['the workflow'] : []),
    ...Object.entries(jobs).filter(([, job]) => !isKanonLaneCall(job) && SECRET.test(JSON.stringify(job))).map(([name]) => name),
  ];
  return where.map((w) => `${f} (on ${events.join(', ')}): ${w} reads a secret`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('no job that holds an App key runs someone else\'s code (Kanon\'s check, copied)', () => {
  it('finds the jobs it is about, so the check is not vacuous', () => {
    const keyed = Object.entries(docs).flatMap(([f, d]) => Object.entries(d?.jobs ?? {}).filter(([, j]) => holdsKey(j)).map(([n]) => `${f}:${n}`));
    expect(keyed).toEqual(expect.arrayContaining(['e2e-act-run.yml:mint', 'e2e.yml:start', 'apps-check.yml:apps', 'release.yml:release']));
  });

  it('holds for every job, with no exception', () => {
    expect(violations(docs)).toEqual({});
  });
});

describe('each environment is named only by the jobs plan 0012 §5.2 lists', () => {
  it('finds the jobs that name one, so the check is not vacuous', () => {
    const named = environmentJobs(docs).map(({ file, job }) => `${file}:${job}`);
    expect(named).toEqual(expect.arrayContaining(['e2e.yml:provision', 'e2e.yml:start', 'e2e-model-key-job.yml:write']));
  });

  it('holds for every job', () => {
    expect(strayEnvironments(docs)).toEqual([]);
  });

  it('every environment named is one of the harness\'s three', () => {
    expect([...new Set(environmentJobs(docs).map(({ environment }) => environment))].filter((e) => !['e2e', 'e2e-model', 'e2e-report'].includes(e))).toEqual([]);
  });
});

describe('no `-job` workflow names a private key', () => {
  it('finds the `-job` workflows there are, and none names one', () => {
    expect(keyedJobWorkflows(Object.fromEntries(files.map((f) => [f, workflowText(f)])))).toEqual([]);
  });
});

describe('`e2e.yml`\'s `verdict` files issues with its workflow token, and holds no key (E8, #40)', () => {
  const verdict = docs['e2e.yml'].jobs.verdict;

  it('has `issues: write` on this repository, `contents: read`, and `actions: read` for the run\'s jobs list (#24), nothing more', () => {
    expect(verdict.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
  });

  it('its only token is the workflow\'s own: no environment, no secret, no key, no App token', () => {
    expect(environmentOf(verdict)).toBeUndefined();
    expect(holdsKey(verdict)).toBe(false);
    expect(SECRET.test(JSON.stringify(verdict))).toBe(false);
    expect(verdict.steps.filter((s) => String(s.uses ?? '').startsWith('actions/create-github-app-token'))).toEqual([]);
    expect(verdict.steps.flatMap((s) => Object.entries(s.env ?? {})).filter(([, v]) => /token/i.test(String(v)))).toEqual([['GH_TOKEN', '${{ github.token }}']]);
  });
});

describe('no workflow runs on `pull_request`, `pull_request_target` or `merge_group` with a secret', () => {
  it('finds the workflows it is about, so the check is not vacuous', () => {
    const onPr = files.filter((f) => eventsOf(docs[f]).some((e) => PR_EVENTS.includes(e)));
    expect(onPr).toEqual(expect.arrayContaining(['ci.yml', 'agent-review.yml']));
  });

  it('holds for every workflow; Kanon\'s lane callers pass their secrets only into the lane', () => {
    expect(secretsOnPullRequests(docs)).toEqual([]);
  });
});

describe('the checks catch what they are for', () => {
  const mint = { uses: 'actions/create-github-app-token@v3', with: { 'private-key': '${{ secrets.DRIVER_APP_KEY }}' } };

  it('a key held in a job that runs the agent, a `./` action, or a checkout of another ref', () => {
    expect(violations({ 'x.yml': { jobs: {
      agent: { steps: [mint, { uses: 'yedeya-labs/kanon/actions/agent-run@v1.2.3' }] },
      hook: { steps: [mint, { uses: './.github/actions/project-setup' }] },
      pr: { steps: [mint, { uses: 'actions/checkout@v7', with: { ref: '${{ inputs.ref }}' } }] },
      plain: { steps: [mint, { uses: 'actions/checkout@v7' }] },
    } } })).toEqual({
      'x.yml:agent': 'runs the agent',
      'x.yml:hook': 'runs `./.github/actions/project-setup` from the checkout',
      'x.yml:pr': 'checks out a ref other than the triggering commit',
    });
  });

  it('every spelling of the harness\'s keys and Kanon\'s', () => {
    for (const k of ['${{ secrets.DRIVER_APP_KEY }}', '${{ secrets.REPORTER_APP_KEY }}', '${{ secrets.RELEASER_APP_PRIVATE_KEY }}', '${{ secrets.app-private-key }}', "${{ secrets[format('{0}_APP_KEY', matrix.app)] }}"]) {
      expect(holdsKey({ steps: [{ uses: 'x', with: { 'private-key': k } }] }), k).toBe(true);
    }
    expect(holdsKey({ steps: [{ uses: 'x', with: { token: '${{ secrets.DRIVER_APP_ID }}' } }] })).toBe(false);
  });

  it('an environment named by a job outside §5.2\'s list, by a listed job naming another, or by a second job beside `*`', () => {
    expect(strayEnvironments({
      'e2e.yml': { jobs: { plan: { environment: 'e2e' }, provision: { environment: { name: 'e2e-model' } }, start: { environment: 'e2e-report' } } },
      'e2e-model-key-job.yml': { jobs: { set: { environment: 'e2e-model' }, extra: { steps: [] } } },
      'probe-99-new.yml': { jobs: { probe: { environment: 'e2e' } } },
    })).toEqual([
      'e2e.yml:plan names `e2e`',
      'e2e.yml:provision names `e2e-model`',
      'e2e-model-key-job.yml:set names `e2e-model`',
      'probe-99-new.yml:probe names `e2e`',
    ]);
    expect(strayEnvironments({ 'e2e-model-key-job.yml': { jobs: { set: { environment: 'e2e-model' } } } })).toEqual([]);
    expect(environmentOf({ environment: { name: 'e2e', url: 'x' } })).toBe('e2e');
  });

  it('a private key named in a `-job` workflow, by secret or as the token action\'s input', () => {
    expect(keyedJobWorkflows({
      'e2e-act-job.yml': 'jobs:\n  run:\n    steps:\n      - env:\n          K: ${{ secrets.DRIVER_APP_KEY }}\n',
      'e2e-kanon-job.yml': 'jobs:\n  run:\n    steps:\n      - uses: actions/create-github-app-token@v3\n        with:\n          private-key: ${{ inputs.k }}\n',
      'e2e-janitor-job.yml': 'on:\n  workflow_call:\n    secrets:\n      app-token:\n        required: true\n',
      'e2e-act-run.yml': 'jobs:\n  mint:\n    steps:\n      - with:\n          private-key: ${{ secrets.DRIVER_APP_KEY }}\n',
    })).toEqual(['e2e-act-job.yml', 'e2e-kanon-job.yml']);
  });

  it('a secret in a workflow that runs on `pull_request`, `pull_request_target` or `merge_group`', () => {
    const lane = { uses: 'yedeya-labs/kanon/.github/workflows/review.yml@v0.41.0', secrets: { JUDGE_APP_ID: '${{ secrets.JUDGE_APP_ID }}' } };
    expect(secretsOnPullRequests({
      'a.yml': { on: { pull_request: null }, jobs: { t: { steps: [{ run: 'x', env: { T: '${{ secrets.X }}' } }] } } },
      'b.yml': { on: ['merge_group'], env: { T: '${{ secrets.X }}' }, jobs: { t: { steps: [] } } },
      'c.yml': { on: 'pull_request_target', jobs: { t: { ...lane, secrets: 'inherit' } } },
      'd.yml': { on: { pull_request_target: null }, jobs: { t: { ...lane, secrets: { JUDGE_APP_ID: '${{ secrets.DRIVER_APP_ID }}' } } } },
      'e.yml': { on: { pull_request: null }, jobs: { t: { ...lane, uses: 'someone/else/.github/workflows/x.yml@v1' } } },
      'f.yml': { on: { pull_request: null }, jobs: { t: { ...lane, environment: 'e2e' } } },
      'ok-lane.yml': { on: { pull_request_target: null }, jobs: { t: lane } },
      'ok-push.yml': { on: { push: null }, jobs: { t: { steps: [{ run: 'x', env: { T: '${{ secrets.X }}' } }] } } },
    }).map((l) => l.split(' ')[0])).toEqual(['a.yml', 'b.yml', 'c.yml', 'd.yml', 'e.yml', 'f.yml']);
  });
});
