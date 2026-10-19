#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateRoutingTrace, summarizeRoutingTraces, validateRoutingCampaign, buildRoutingSchedule } from './routing-traces.mjs';

const usage = 'Usage: node scripts/benchmark-routing.mjs (--traces <supplied.jsonl> --manifest <manifest.json> | --validate-campaign <json> | --schedule <json>) (OFFLINE only; execution unauthorized)';
function argumentsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--traces', '--manifest', '--validate-campaign', '--schedule'].includes(flag)) throw new Error(`Unknown option ${flag}. ${usage}`);
    if (options[flag]) throw new Error(`Duplicate option ${flag}. ${usage}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path. ${usage}`);
    options[flag] = resolve(value);
  }
  const campaignModes = ['--validate-campaign', '--schedule'].filter(flag => options[flag]);
  if (campaignModes.length) {
    if (campaignModes.length !== 1 || Object.keys(options).length !== 1) throw new Error(`Modes are mutually exclusive. ${usage}`);
  } else if (!options['--traces'] || !options['--manifest']) throw new Error(usage);
  return options;
}
async function input(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { throw new Error(`${path}: cannot read input (${error.code}): ${error.message}`); }
}
function parse(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label}: invalid JSON: ${error.message}`); }
}
const source = (path, text) => ({ path, sha256: createHash('sha256').update(text).digest('hex') });
async function run() {
  const args = argumentsFor(process.argv.slice(2));
  const campaignPath = args['--validate-campaign'] ?? args['--schedule'];
  if (campaignPath) {
    const text = await input(campaignPath);
    const campaign = validateRoutingCampaign(parse(text, campaignPath));
    return { version: 1, mode: 'offline', executionAuthorized: false, executionStatus: 'not_attempted',
      externalReadinessVerified: false, structuralValidation: 'supplied_commitments_accepted',
      campaign, ...(args['--schedule'] ? { assignments: buildRoutingSchedule(campaign) } : {}),
      inputs: { campaign: source(campaignPath, text) } };
  }
  const tracesPath = args['--traces']; const manifestPath = args['--manifest'];
  const tracesText = await input(tracesPath); const manifestText = await input(manifestPath);
  const lines = tracesText.split(/\r?\n/).map((line, index) => ({ line, number: index + 1 })).filter(row => row.line.trim());
  if (lines.length === 0) throw new Error(`${tracesPath}: JSONL requires at least one supplied trace`);
  const parsed = lines.map(row => ({ value: parse(row.line, `${tracesPath}:${row.number}`), number: row.number }));
  const traces = parsed.map(row => {
    try { return validateRoutingTrace(row.value); }
    catch (error) { throw new Error(`${tracesPath}:${row.number}: ${error.message}`); }
  });
  const manifest = parse(manifestText, manifestPath);
  let report;
  try { report = summarizeRoutingTraces(traces, manifest); }
  catch (error) { throw new Error(`${manifestPath} / ${tracesPath}: ${error.message}`); }
  report.inputs = { traces: source(tracesPath, tracesText), manifest: source(manifestPath, manifestText) };
  return report;
}
try {
  process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Offline routing report (execution unauthorized; not attempted): ${error.message}\n`);
  process.exitCode = 1;
}
