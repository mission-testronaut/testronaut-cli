#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.resolve(HERE, '../bin/cli.js');
const DEFAULT_REPOS = {
  openai: '/home/shane/workspace/testronaut-examples',
  gemini: '/home/shane/workspace/e2e-testing-collegium',
};

export const BENCHMARK_TARGETS = {
  openai: {
    provider: 'openai',
    repo: DEFAULT_REPOS.openai,
    missions: [
      'missions/login.mission.js',
      'missions/removeTask.mission.js',
      'missions/fileTransfer.mission.js',
    ],
    conditions: [
      { id: 'l1_terra_control', level: 1, primary: 'gpt-5.6-terra', objective: 'off', mode: 'off' },
      { id: 'l2_terra_guarded', level: 2, primary: 'gpt-5.6-terra', objective: 'tokens', mode: 'live' },
      { id: 'l2_luna_guarded', level: 2, primary: 'gpt-5.6-luna', objective: 'tokens', mode: 'live' },
      { id: 'l2_gpt55_guarded', level: 2, primary: 'gpt-5.5', objective: 'tokens', mode: 'live' },
      { id: 'l3_terra_luna', level: 3, primary: 'gpt-5.6-terra', secondary: 'gpt-5.6-luna', objective: 'cost', mode: 'live' },
      { id: 'l4_terra_gpt55', level: 4, primary: 'gpt-5.6-terra', secondary: 'gpt-5.5', objective: 'cost', mode: 'live' },
      { id: 'l4_terra_gpt54', level: 4, primary: 'gpt-5.6-terra', secondary: 'gpt-5.4', objective: 'cost', mode: 'live' },
    ],
  },
  gemini: {
    provider: 'gemini',
    repo: DEFAULT_REPOS.gemini,
    missions: [
      'missions/profileNavigation.mission.js',
      'missions/projectsDashboard.mission.js',
      'missions/projectWorkspaceNavigation.mission.js',
    ],
    conditions: [
      { id: 'l1_gemini38_control', level: 1, primary: 'gemini-3.8-flash', objective: 'off', mode: 'off' },
      { id: 'l2_gemini38_guarded', level: 2, primary: 'gemini-3.8-flash', objective: 'tokens', mode: 'live' },
      { id: 'l2_gemini36_guarded', level: 2, primary: 'gemini-3.6-flash', objective: 'tokens', mode: 'live' },
      { id: 'l2_gemini35lite_guarded', level: 2, primary: 'gemini-3.5-flash-lite', objective: 'tokens', mode: 'live' },
      { id: 'l3_gemini38_gemini37', level: 3, primary: 'gemini-3.8-flash', secondary: 'gemini-3.7-flash', objective: 'cost', mode: 'live' },
      { id: 'l4_gemini38_gemini36', level: 4, primary: 'gemini-3.8-flash', secondary: 'gemini-3.6-flash', objective: 'cost', mode: 'live' },
      { id: 'l4_gemini38_gemini35lite', level: 4, primary: 'gemini-3.8-flash', secondary: 'gemini-3.5-flash-lite', objective: 'cost', mode: 'live' },
    ],
  },
};

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value += 0x6D2B79F5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, seed) {
  const result = [...values];
  const random = seededRandom(hashSeed(seed));
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function buildBenchmarkSchedule({ repetitions = 5, targets = ['openai', 'gemini'], seed = 'optimization-pilot-v1' } = {}) {
  const schedule = [];
  for (let block = 1; block <= repetitions; block += 1) {
    for (const targetName of targets) {
      const target = BENCHMARK_TARGETS[targetName];
      if (!target) throw new Error(`Unknown benchmark target: ${targetName}`);
      for (const condition of shuffled(target.conditions, `${seed}:${targetName}:${block}`)) {
        schedule.push({
          key: `${targetName}:b${block}:${condition.id}`,
          target: targetName,
          block,
          provider: target.provider,
          repo: target.repo,
          missions: target.missions,
          ...condition,
        });
      }
    }
  }
  return schedule;
}

export function commandForRun(run, cliPath = DEFAULT_CLI) {
  return {
    command: process.execPath,
    args: [
      cliPath,
      `--provider=${run.provider}`,
      `--model=${run.primary}`,
      `--optimize=${run.objective}`,
      `--optimization-mode=${run.mode}`,
      ...run.missions,
    ],
    env: {
      TESTRONAUT_JEV_ROUTING_THRESHOLD: '0.4',
      ...(run.secondary ? { TESTRONAUT_JEV_FAST_MODEL: run.secondary } : {}),
    },
  };
}

function parseArgs(argv) {
  const read = (name, fallback) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const target = read('target', 'both');
  return {
    dryRun: argv.includes('--dry-run'),
    repetitions: Math.max(1, Number.parseInt(read('repetitions', '5'), 10) || 5),
    targets: target === 'both' ? ['openai', 'gemini'] : target.split(',').filter(Boolean),
    seed: read('seed', 'optimization-pilot-v1'),
    experimentId: read('experiment-id', 'optimization-pilot-v1'),
    cliPath: path.resolve(read('cli', DEFAULT_CLI)),
  };
}

function reportFiles(repo) {
  const directory = path.join(repo, 'missions/mission_reports');
  if (!fs.existsSync(directory)) return new Set();
  return new Set(fs.readdirSync(directory).filter(file => /^run_\d+\.json$/.test(file)));
}

function findNewReport(repo, before) {
  const directory = path.join(repo, 'missions/mission_reports');
  if (!fs.existsSync(directory)) return null;
  const candidates = fs.readdirSync(directory)
    .filter(file => /^run_\d+\.json$/.test(file) && !before.has(file))
    .map(file => ({ file, time: fs.statSync(path.join(directory, file)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return candidates[0] ? path.join(directory, candidates[0].file) : null;
}

function loadState(file, metadata) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ...metadata, runs: {} }; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSummaryCsv(file, state) {
  const columns = [
    'key', 'target', 'block', 'level', 'condition', 'primary', 'secondary', 'objective',
    'status', 'runId', 'passed', 'failed', 'turns', 'tokens', 'routedTurns',
    'forcedPrimaryRetries', 'completionGates', 'jevInputTokens', 'jevOutputTokens',
  ];
  const escape = value => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = Object.entries(state.runs).map(([key, run]) => {
    const metrics = run.metrics || {};
    return [
      key, run.target, run.block, run.level, run.id, run.primary, run.secondary, run.objective,
      run.status, metrics.runId, metrics.passed, metrics.failed, metrics.turns, metrics.tokens,
      metrics.routedTurns, metrics.forcedPrimaryRetries, metrics.completionGates,
      metrics.jevInputTokens, metrics.jevOutputTokens,
    ].map(escape).join(',');
  });
  fs.writeFileSync(file, `${columns.join(',')}\n${rows.join('\n')}\n`);
}

function summarizeReport(reportPath) {
  if (!reportPath) return null;
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const steps = report.missions?.flatMap(mission => mission.steps || []) || [];
    const models = {};
    for (const step of steps) {
      const model = step.model || report.llm?.model || 'unknown';
      models[model] ||= { turns: 0, tokens: 0 };
      models[model].turns += 1;
      models[model].tokens += Number(step.tokensUsed || 0);
    }
    return {
      runId: report.runId,
      passed: report.summary?.passed || 0,
      failed: report.summary?.failed || 0,
      turns: steps.length,
      tokens: steps.reduce((sum, step) => sum + Number(step.tokensUsed || 0), 0),
      routedTurns: steps.filter(step => step.modelRouting?.applied).length,
      forcedPrimaryRetries: steps.filter(step => step.modelRouting?.forcedPrimaryRetry).length,
      jevInputTokens: Number(report.jevShadow?.inputTokens || 0),
      jevOutputTokens: Number(report.jevShadow?.outputTokens || 0),
      completionGates: Number(report.jevShadow?.triggeredCompletions || 0),
      models,
    };
  } catch {
    return null;
  }
}

export function runBenchmark(options) {
  const schedule = buildBenchmarkSchedule(options);
  if (options.dryRun) return { schedule, completed: 0, skipped: 0 };

  const stateRoot = path.resolve(HERE, 'results', options.experimentId);
  const stateFile = path.join(stateRoot, 'state.json');
  const state = loadState(stateFile, {
    experimentId: options.experimentId,
    seed: options.seed,
    repetitions: options.repetitions,
    targets: options.targets,
    createdAt: new Date().toISOString(),
  });
  let completed = 0;
  let skipped = 0;

  for (const run of schedule) {
    if (state.runs[run.key]?.status === 'completed') {
      skipped += 1;
      continue;
    }
    const invocation = commandForRun(run, options.cliPath);
    console.log(`\n[${run.key}] ${run.primary}${run.secondary ? ` -> ${run.secondary}` : ''} (${run.objective}/${run.mode})`);
    const before = reportFiles(run.repo);
    const logFile = path.join(stateRoot, 'logs', `${run.key.replaceAll(':', '_')}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const startedAt = new Date().toISOString();
    const env = { ...process.env, ...invocation.env };
    if (!run.secondary) delete env.TESTRONAUT_JEV_FAST_MODEL;
    Object.assign(env, {
      TESTRONAUT_EXPERIMENT_ID: options.experimentId,
      TESTRONAUT_EXPERIMENT_CONDITION: run.id,
      TESTRONAUT_EXPERIMENT_BLOCK: String(run.block),
    });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: run.repo,
      env,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    });
    fs.writeFileSync(logFile, `${result.stdout || ''}${result.stderr || ''}`);
    const reportPath = findNewReport(run.repo, before);
    const status = reportPath ? 'completed' : 'no_report';
    state.runs[run.key] = {
      ...run,
      status,
      exitCode: result.status,
      signal: result.signal,
      startedAt,
      endedAt: new Date().toISOString(),
      reportPath,
      logFile,
      metrics: summarizeReport(reportPath),
    };
    writeJson(stateFile, state);
    writeSummaryCsv(path.join(stateRoot, 'runs.csv'), state);
    console.log(`[${run.key}] ${status}; exit=${result.status}; report=${reportPath || 'none'}`);
    if (status === 'completed') completed += 1;
  }
  return { schedule, completed, skipped, stateFile };
}

function printSchedule(schedule) {
  console.log(`Optimization benchmark schedule: ${schedule.length} runs`);
  for (const run of schedule) {
    const secondary = run.secondary ? ` -> ${run.secondary}` : '';
    console.log(`${run.key} | L${run.level} | ${run.primary}${secondary} | ${run.objective}/${run.mode} | ${run.missions.length} missions`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = runBenchmark(options);
  if (options.dryRun) printSchedule(result.schedule);
  else console.log(`Benchmark progress saved to ${result.stateFile}. Completed ${result.completed}; resumed/skipped ${result.skipped}.`);
}

export const __benchmarkInternals = { hashSeed, seededRandom, shuffled, parseArgs, summarizeReport };
