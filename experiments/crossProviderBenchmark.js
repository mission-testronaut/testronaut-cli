#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { evaluateJevShadow, resolveJevShadowConfig } from '../core/jevShadow.js';
import { __benchmarkInternals } from './optimizationBenchmark.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.resolve(HERE, '../bin/cli.js');
const DEFAULT_REPO = '/home/shane/workspace/testronaut-examples';
const MISSIONS = [
  'missions/login.mission.js',
  'missions/removeTask.mission.js',
  'missions/fileTransfer.mission.js',
];

const MODELS = {
  gpt55: { provider: 'openai', model: 'gpt-5.5', profile: 'Strongest OpenAI reliability and token result in the prior pilot; slower than Terra.' },
  terra: { provider: 'openai', model: 'gpt-5.6-terra', profile: 'Current-generation balanced OpenAI reference.' },
  gemini38: { provider: 'gemini', model: 'gemini-3.8-flash', profile: 'Reliable current-generation Gemini reference.' },
  gemini35lite: { provider: 'gemini', model: 'gemini-3.5-flash-lite', profile: 'Low-cost Gemini candidate; prior guarded runs were reliable but slower.' },
};

export const CROSS_PROVIDER_CONDITIONS = [
  { id: 'c1_gpt55', candidates: [MODELS.gpt55] },
  { id: 'c2_terra', candidates: [MODELS.terra] },
  { id: 'c3_gemini38', candidates: [MODELS.gemini38] },
  { id: 'c4_gemini35lite', candidates: [MODELS.gemini35lite] },
  { id: 'x1_gpt55_gemini38', candidates: [MODELS.gpt55, MODELS.gemini38] },
  { id: 'x2_gpt55_gemini35lite', candidates: [MODELS.gpt55, MODELS.gemini35lite] },
  { id: 'x3_terra_gemini38', candidates: [MODELS.terra, MODELS.gemini38] },
  { id: 'x4_terra_gemini35lite', candidates: [MODELS.terra, MODELS.gemini35lite] },
];

export function buildCrossProviderSchedule({ repetitions = 5, seed = 'cross-provider-pilot-v1', repo = DEFAULT_REPO } = {}) {
  const schedule = [];
  for (let block = 1; block <= repetitions; block += 1) {
    const conditions = __benchmarkInternals.shuffled(CROSS_PROVIDER_CONDITIONS, `${seed}:conditions:${block}`);
    for (const condition of conditions) {
      const missions = __benchmarkInternals.shuffled(MISSIONS, `${seed}:${condition.id}:${block}`);
      for (const mission of missions) {
        const unit = path.basename(mission, '.mission.js');
        schedule.push({
          key: `b${block}:${condition.id}:${unit}`,
          block,
          unit,
          mission,
          repo,
          ...condition,
        });
      }
    }
  }
  return schedule;
}

export function interpretSelection(evaluation, candidates, threshold = 0.55) {
  const fallback = candidates[0];
  if (candidates.length === 1) return { selected: fallback, selectedBy: 'fixed', score: 1, evaluation: null };
  const answer = evaluation?.answers?.executionModel;
  const index = String(answer?.choice || '').match(/^model_(\d+)$/)?.[1];
  const candidate = index ? candidates[Number(index) - 1] : null;
  const score = candidate ? Number(answer?.probabilities?.[`model_${index}`]) : Number.NaN;
  if (evaluation?.status === 'ok' && candidate && Number.isFinite(score) && score >= threshold) {
    return { selected: candidate, selectedBy: 'jev', score, evaluation };
  }
  return {
    selected: fallback,
    selectedBy: 'fallback',
    score: Number.isFinite(score) ? score : null,
    reason: evaluation?.status === 'ok' ? 'low_or_invalid_probability' : evaluation?.reason || evaluation?.error || 'no_evaluation',
    evaluation,
  };
}

export async function selectExecutionModel(run, { env = process.env, threshold = 0.55, fetchImpl } = {}) {
  if (run.candidates.length === 1) return interpretSelection(null, run.candidates, threshold);
  const missionText = fs.readFileSync(path.join(run.repo, run.mission), 'utf8').slice(0, 12000);
  const criteria = Object.fromEntries(run.candidates.map((candidate, index) => [
    `model_${index + 1}`,
    `${candidate.provider}/${candidate.model}: ${candidate.profile}`,
  ]));
  const evaluation = await evaluateJevShadow({
    task: 'Choose one execution model before a browser-testing mission starts.',
    mission: missionText,
    constraints: ['One model owns the entire mission transcript.', 'Do not assume cross-provider failover.', 'Prefer lower expected spend when reliability is comparable.'],
  }, {
    config: { ...resolveJevShadowConfig(env), enabled: true, strategiesEnabled: false },
    questions: {
      executionModel: {
        type: 'choice',
        instructions: 'Choose the least expensive candidate likely to complete this mission reliably.',
        criteria,
      },
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return interpretSelection(evaluation, run.candidates, threshold);
}

export function commandForCrossProviderRun(run, selection, cliPath = DEFAULT_CLI) {
  return {
    command: process.execPath,
    args: [cliPath, `--provider=${selection.selected.provider}`, `--model=${selection.selected.model}`, '--optimize=tokens', '--optimization-mode=live', run.mission],
  };
}

function parseArgs(argv) {
  const read = (name, fallback) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  return {
    dryRun: argv.includes('--dry-run'),
    repetitions: Math.max(1, Number.parseInt(read('repetitions', '5'), 10) || 5),
    seed: read('seed', 'cross-provider-pilot-v1'),
    experimentId: read('experiment-id', 'cross-provider-pilot-v1'),
    repo: path.resolve(read('repo', DEFAULT_REPO)),
    cliPath: path.resolve(read('cli', DEFAULT_CLI)),
    threshold: Math.min(1, Math.max(0, Number(read('selection-threshold', '0.55')) || 0.55)),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function reportFiles(repo) {
  const directory = path.join(repo, 'missions/mission_reports');
  if (!fs.existsSync(directory)) return new Set();
  return new Set(fs.readdirSync(directory).filter(file => /^run_\d+\.json$/.test(file)));
}

function findNewReport(repo, before) {
  const directory = path.join(repo, 'missions/mission_reports');
  if (!fs.existsSync(directory)) return null;
  const file = fs.readdirSync(directory)
    .filter(name => /^run_\d+\.json$/.test(name) && !before.has(name))
    .map(name => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time)[0]?.name;
  return file ? path.join(directory, file) : null;
}

function summarize(reportPath) {
  if (!reportPath) return null;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const steps = report.missions?.flatMap(mission => mission.steps || []) || [];
    return {
      runId: report.runId,
      passed: report.summary?.passed || 0,
      failed: report.summary?.failed || 0,
      turns: steps.length,
      tokens: steps.reduce((sum, step) => sum + Number(step.tokensUsed || 0), 0),
      jevInputTokens: Number(report.jevShadow?.inputTokens || 0),
      jevOutputTokens: Number(report.jevShadow?.outputTokens || 0),
    };
  } catch { return null; }
}

function writeCsv(file, state) {
  const columns = ['key', 'block', 'condition', 'mission', 'provider', 'model', 'selectedBy', 'score', 'status', 'passed', 'failed', 'turns', 'tokens', 'jevInputTokens', 'jevOutputTokens'];
  const quote = value => /[",\n]/.test(String(value ?? '')) ? `"${String(value ?? '').replaceAll('"', '""')}"` : String(value ?? '');
  const rows = Object.values(state.runs).map(run => [run.key, run.block, run.id, run.mission, run.selection?.selected?.provider, run.selection?.selected?.model, run.selection?.selectedBy, run.selection?.score, run.status, run.metrics?.passed, run.metrics?.failed, run.metrics?.turns, run.metrics?.tokens, run.metrics?.jevInputTokens, run.metrics?.jevOutputTokens].map(quote).join(','));
  fs.writeFileSync(file, `${columns.join(',')}\n${rows.join('\n')}\n`);
}

export async function runCrossProviderBenchmark(options) {
  dotenv.config({ path: path.join(options.repo, '.env'), override: false, quiet: true });
  const schedule = buildCrossProviderSchedule(options);
  if (options.dryRun) return { schedule, completed: 0, skipped: 0 };
  const root = path.resolve(HERE, 'results', options.experimentId);
  const stateFile = path.join(root, 'state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = { experimentId: options.experimentId, seed: options.seed, repetitions: options.repetitions, createdAt: new Date().toISOString(), runs: {} }; }
  let completed = 0;
  let skipped = 0;
  for (const run of schedule) {
    if (state.runs[run.key]?.status === 'completed') { skipped += 1; continue; }
    let selection = state.runs[run.key]?.selection;
    if (!selection) {
      selection = await selectExecutionModel(run, { threshold: options.threshold });
      state.runs[run.key] = { ...run, status: 'selected', selection };
      writeJson(stateFile, state);
    }
    const invocation = commandForCrossProviderRun(run, selection, options.cliPath);
    console.log(`\n[${run.key}] ${selection.selected.provider}/${selection.selected.model} (${selection.selectedBy})`);
    const before = reportFiles(run.repo);
    const logFile = path.join(root, 'logs', `${run.key.replaceAll(':', '_')}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const env = { ...process.env,
      TESTRONAUT_EXPERIMENT_ID: options.experimentId,
      TESTRONAUT_EXPERIMENT_CONDITION: run.id,
      TESTRONAUT_EXPERIMENT_BLOCK: String(run.block),
      TESTRONAUT_EXPERIMENT_UNIT: run.unit,
      TESTRONAUT_EXPERIMENT_SELECTED_BY: selection.selectedBy,
      TESTRONAUT_EXPERIMENT_SELECTION_SCORE: selection.score == null ? '' : String(selection.score),
    };
    delete env.TESTRONAUT_JEV_FAST_MODEL;
    const startedAt = new Date().toISOString();
    const result = spawnSync(invocation.command, invocation.args, { cwd: run.repo, env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 });
    fs.writeFileSync(logFile, `${result.stdout || ''}${result.stderr || ''}`);
    const reportPath = findNewReport(run.repo, before);
    const status = reportPath ? 'completed' : 'no_report';
    state.runs[run.key] = { ...run, status, selection, exitCode: result.status, signal: result.signal, startedAt, endedAt: new Date().toISOString(), reportPath, logFile, metrics: summarize(reportPath) };
    writeJson(stateFile, state);
    writeCsv(path.join(root, 'runs.csv'), state);
    console.log(`[${run.key}] ${status}; exit=${result.status}; report=${reportPath || 'none'}`);
    if (status === 'completed') completed += 1;
  }
  return { schedule, completed, skipped, stateFile };
}

function printSchedule(schedule) {
  console.log(`Cross-provider benchmark schedule: ${schedule.length} isolated mission executions`);
  for (const run of schedule) console.log(`${run.key} | ${run.candidates.map(item => `${item.provider}/${item.model}`).join(' vs ')} | ${run.mission}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCrossProviderBenchmark(options);
  if (options.dryRun) printSchedule(result.schedule);
  else console.log(`Benchmark progress saved to ${result.stateFile}. Completed ${result.completed}; resumed/skipped ${result.skipped}.`);
}

export const __crossProviderInternals = { parseArgs };
