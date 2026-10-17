// Reads the harness's own workflows, for the workflow test and the escalation test.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const WF = '.github/workflows';

/** Every workflow file's name, sorted. */
export const workflowFiles = () => readdirSync(WF).filter((f) => /\.ya?ml$/.test(f)).sort();

/** One workflow's text. @param {string} f */
export const workflowText = (f) => readFileSync(join(WF, f), 'utf8');

/** Every workflow, parsed, by file name. @returns {Record<string, any>} */
export const readWorkflows = () => Object.fromEntries(workflowFiles().map((f) => [f, parse(workflowText(f))]));

/** The environment a job declares, by name, or undefined. `environment:` is a name or `{ name, url }`. */
export const environmentOf = (job) => {
  const env = job?.environment;
  if (env === undefined || env === null) return undefined;
  return typeof env === 'object' ? String(env.name) : String(env);
};

/** Every `file:job` that declares an environment, with the environment's name. */
export const environmentJobs = (docs) =>
  Object.entries(docs).flatMap(([f, doc]) =>
    Object.entries(doc?.jobs ?? {}).flatMap(([name, job]) => {
      const env = environmentOf(job);
      return env === undefined ? [] : [{ file: f, job: name, environment: env }];
    }));
