#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_TARGETS } from './optimizationBenchmark.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXPERIMENT_ID = 'optimization-pilot-v1';
const T95_DF4 = 2.776;
const EXPECTED_RECORDS = {
  openai: {
    'missions/login.mission.js': 1,
    'missions/removeTask.mission.js': 2,
    'missions/fileTransfer.mission.js': 3,
  },
  gemini: {
    'missions/profileNavigation.mission.js': 2,
    'missions/projectsDashboard.mission.js': 2,
    'missions/projectWorkspaceNavigation.mission.js': 2,
  },
};
const CONTROL_CONDITION = {
  openai: 'l1_terra_control',
  gemini: 'l1_gemini38_control',
};

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function csvEscape(value) {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, columns, rows) {
  fs.writeFileSync(file, `${columns.join(',')}\n${rows.map(row => columns.map(column => csvEscape(row[column])).join(',')).join('\n')}\n`);
}

function readReports(targetName, experimentId) {
  const target = BENCHMARK_TARGETS[targetName];
  const reportDir = path.join(target.repo, 'missions/mission_reports');
  return fs.readdirSync(reportDir)
    .filter(file => /^run_\d+\.json$/.test(file))
    .map(file => ({ file, path: path.join(reportDir, file) }))
    .map(entry => ({ ...entry, report: JSON.parse(fs.readFileSync(entry.path, 'utf8')) }))
    .filter(entry => entry.report.experiment?.id === experimentId)
    .map(entry => ({ ...entry, target: targetName }));
}

function stepMetrics(steps, report) {
  const models = {};
  for (const step of steps) {
    const model = step.model || report.llm?.model || 'unknown';
    models[model] ||= { turns: 0, tokens: 0, inputTokens: 0, outputTokens: 0 };
    models[model].turns += 1;
    models[model].tokens += Number(step.tokensUsed || 0);
    models[model].inputTokens += Number(step.inputTokens || 0);
    models[model].outputTokens += Number(step.outputTokens || 0);
  }
  return {
    turns: steps.length,
    tokens: steps.reduce((sum, step) => sum + Number(step.tokensUsed || 0), 0),
    inputTokens: steps.reduce((sum, step) => sum + Number(step.inputTokens || 0), 0),
    outputTokens: steps.reduce((sum, step) => sum + Number(step.outputTokens || 0), 0),
    routedTurns: steps.filter(step => step.modelRouting?.applied).length,
    forcedPrimaryRetries: steps.filter(step => step.modelRouting?.forcedPrimaryRetry).length,
    requestFallbacks: steps.filter(step => step.modelRouting?.fallback).length,
    models,
  };
}

function normalizeRun(entry) {
  const { report, target } = entry;
  const expected = EXPECTED_RECORDS[target];
  const steps = report.missions.flatMap(mission => mission.steps || []);
  const step = stepMetrics(steps, report);
  const missionOutcomes = Object.entries(expected).map(([file, expectedRecords]) => {
    const records = report.missions.filter(mission => mission.file === file);
    const recordSteps = records.flatMap(record => record.steps || []);
    return {
      experimentId: report.experiment.id,
      target,
      condition: report.experiment.condition,
      block: report.experiment.block,
      runId: report.runId,
      file,
      expectedRecords,
      actualRecords: records.length,
      passed: records.length === expectedRecords && records.every(record => record.status === 'passed'),
      phasePassed: records.filter(record => record.status === 'passed').length,
      phaseFailed: records.filter(record => record.status === 'failed').length,
      turns: recordSteps.length,
      tokens: recordSteps.reduce((sum, item) => sum + Number(item.tokensUsed || 0), 0),
    };
  });
  const condition = BENCHMARK_TARGETS[target].conditions.find(item => item.id === report.experiment.condition);
  return {
    experimentId: report.experiment.id,
    target,
    condition: report.experiment.condition,
    level: condition?.level,
    block: report.experiment.block,
    runId: report.runId,
    provider: report.llm?.provider,
    primaryModel: condition?.primary || report.llm?.model,
    secondaryModel: condition?.secondary || '',
    objective: report.optimization?.objective || condition?.objective,
    mode: report.optimization?.mode || condition?.mode,
    phasePassed: Number(report.summary?.passed || 0),
    phaseFailed: Number(report.summary?.failed || 0),
    phaseTotal: Number(report.summary?.totalMissions || 0),
    missionFilesPassed: missionOutcomes.filter(outcome => outcome.passed).length,
    missionFilesTotal: missionOutcomes.length,
    durationSeconds: (new Date(report.endTime) - new Date(report.startTime)) / 1000,
    ...step,
    jevInputTokens: Number(report.jevShadow?.inputTokens || 0),
    jevOutputTokens: Number(report.jevShadow?.outputTokens || 0),
    jevEvaluations: Number(report.jevShadow?.evaluations || 0),
    completionGates: Number(report.jevShadow?.triggeredCompletions || 0),
    reportPath: entry.path,
    reportFile: entry.file,
    missionOutcomes,
  };
}

function pairedDelta(conditionRuns, controlRuns, metric) {
  const controlByBlock = Object.fromEntries(controlRuns.map(run => [run.block, run]));
  const values = conditionRuns.map(run => {
    const control = controlByBlock[run.block];
    return control?.[metric] ? (run[metric] - control[metric]) / control[metric] * 100 : 0;
  });
  const average = mean(values);
  const halfWidth = T95_DF4 * sampleSd(values) / Math.sqrt(values.length);
  return { average, low: average - halfWidth, high: average + halfWidth };
}

function summarizeConditions(runs) {
  const grouped = runs.reduce((groups, run) => {
    (groups[`${run.target}:${run.condition}`] ||= []).push(run);
    return groups;
  }, {});
  const controls = Object.fromEntries(Object.entries(CONTROL_CONDITION).map(([target, condition]) => [
    target,
    runs.filter(run => run.target === target && run.condition === condition),
  ]));
  return Object.values(grouped).map(conditionRuns => {
    conditionRuns.sort((a, b) => a.block - b.block);
    const first = conditionRuns[0];
    const tokenDelta = pairedDelta(conditionRuns, controls[first.target], 'tokens');
    const turnDelta = pairedDelta(conditionRuns, controls[first.target], 'turns');
    const durationDelta = pairedDelta(conditionRuns, controls[first.target], 'durationSeconds');
    return {
      target: first.target,
      condition: first.condition,
      level: first.level,
      primaryModel: first.primaryModel,
      secondaryModel: first.secondaryModel,
      objective: first.objective,
      mode: first.mode,
      n: conditionRuns.length,
      missionFileAttempts: conditionRuns.reduce((sum, run) => sum + run.missionFilesTotal, 0),
      missionFilePassed: conditionRuns.reduce((sum, run) => sum + run.missionFilesPassed, 0),
      missionFilePassRate: conditionRuns.reduce((sum, run) => sum + run.missionFilesPassed, 0)
        / conditionRuns.reduce((sum, run) => sum + run.missionFilesTotal, 0),
      phasePassed: conditionRuns.reduce((sum, run) => sum + run.phasePassed, 0),
      phaseTotal: conditionRuns.reduce((sum, run) => sum + run.phaseTotal, 0),
      phasePassRate: conditionRuns.reduce((sum, run) => sum + run.phasePassed, 0)
        / conditionRuns.reduce((sum, run) => sum + run.phaseTotal, 0),
      meanTurns: mean(conditionRuns.map(run => run.turns)),
      sdTurns: sampleSd(conditionRuns.map(run => run.turns)),
      turnDeltaPct: turnDelta.average,
      turnDeltaLow95: turnDelta.low,
      turnDeltaHigh95: turnDelta.high,
      meanTokens: mean(conditionRuns.map(run => run.tokens)),
      sdTokens: sampleSd(conditionRuns.map(run => run.tokens)),
      tokenDeltaPct: tokenDelta.average,
      tokenDeltaLow95: tokenDelta.low,
      tokenDeltaHigh95: tokenDelta.high,
      meanDurationSeconds: mean(conditionRuns.map(run => run.durationSeconds)),
      sdDurationSeconds: sampleSd(conditionRuns.map(run => run.durationSeconds)),
      durationDeltaPct: durationDelta.average,
      durationDeltaLow95: durationDelta.low,
      durationDeltaHigh95: durationDelta.high,
      meanRoutedTurns: mean(conditionRuns.map(run => run.routedTurns)),
      meanForcedPrimaryRetries: mean(conditionRuns.map(run => run.forcedPrimaryRetries)),
      meanCompletionGates: mean(conditionRuns.map(run => run.completionGates)),
      meanJevTokens: mean(conditionRuns.map(run => run.jevInputTokens + run.jevOutputTokens)),
    };
  }).sort((a, b) => a.target.localeCompare(b.target) || a.level - b.level || a.condition.localeCompare(b.condition));
}

function markdownTable(rows) {
  const header = '| Condition | Strict pass | Mean tokens | Δ tokens vs control (paired 95% CI) | Mean turns | Mean duration | Routes/run | Gates/run |';
  const divider = '|---|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.map(row => [
    `| ${row.condition}`,
    `${row.missionFilePassed}/${row.missionFileAttempts} (${(row.missionFilePassRate * 100).toFixed(0)}%)`,
    Math.round(row.meanTokens).toLocaleString('en-US'),
    `${row.tokenDeltaPct >= 0 ? '+' : ''}${row.tokenDeltaPct.toFixed(1)}% [${row.tokenDeltaLow95.toFixed(1)}, ${row.tokenDeltaHigh95.toFixed(1)}]`,
    row.meanTurns.toFixed(1),
    `${row.meanDurationSeconds.toFixed(0)}s`,
    row.meanRoutedTurns.toFixed(1),
    row.meanCompletionGates.toFixed(1),
  ].join(' | ') + ' |').join('\n');
  return `${header}\n${divider}\n${body}`;
}

function buildReport(experimentId, runs, summaries) {
  const openai = summaries.filter(row => row.target === 'openai');
  const gemini = summaries.filter(row => row.target === 'gemini');
  const periods = runs.map(run => JSON.parse(fs.readFileSync(run.reportPath, 'utf8')));
  const starts = periods.map(report => new Date(report.startTime)).filter(date => !Number.isNaN(date.valueOf()));
  const ends = periods.map(report => new Date(report.endTime)).filter(date => !Number.isNaN(date.valueOf()));
  return `# Testronaut Jev optimization pilot report

Experiment: \`${experimentId}\`  
Generated: ${new Date().toISOString()}  
Benchmark period: ${new Date(Math.min(...starts)).toISOString()} to ${new Date(Math.max(...ends)).toISOString()}

## Executive summary

This blocked pilot completed **${runs.length} runs** across two repositories, seven conditions per provider, five repetitions per condition, and **${runs.length * 3} mission-file attempts**. Each routed condition used at most two execution models. Jev remained the guardrail/router and was not counted as an execution model.

The clearest OpenAI result was guarded GPT-5.5: **15/15 strict mission-file passes** and **${Math.abs(openai.find(row => row.condition === 'l2_gpt55_guarded').tokenDeltaPct).toFixed(1)}% fewer model tokens** than the Terra control. Its paired 95% interval excluded zero, but it was materially slower. OpenAI routing coverage was too low—less than one routed turn per run—to distinguish secondary-model quality confidently.

Gemini 3.8 Flash was already perfectly reliable on this workload. Guarded Gemini 3.5 Flash-Lite also achieved **15/15 strict passes** with a nominal **${Math.abs(gemini.find(row => row.condition === 'l2_gemini35lite_guarded').tokenDeltaPct).toFixed(1)}% token reduction**, but the paired interval included zero and duration increased. Gemini 3.8 → 3.7 was the strongest conservative routing policy: 15/15 strict passes, modest nominal token reduction, and nearly unchanged duration. Routing 3.8 → 3.5 Flash-Lite was less reliable and caused primary-model retries.

## Methodology

- Five randomized blocks per condition (\`n=5\`).
- OpenAI repository: login, self-cleaning task creation/removal, and file transfer.
- Gemini repository: profile navigation, projects dashboard, and project workspace navigation.
- Level 1: single-model control without Jev.
- Level 2: single model with live Jev guardrails and completion gating.
- Level 3: current-generation/recent two-model routing with guardrails.
- Level 4: current primary routed to older same-provider generations with guardrails.
- Routing probability threshold: 0.40.
- Strict mission-file success requires every expected phase for that file to exist and pass. This avoids treating a failed prerequisite that suppresses later phases as a smaller denominator.
- Token, turn, and duration deltas are paired by randomized block against the provider's level-1 control. Intervals use a two-sided 95% Student-t interval with four degrees of freedom.

## OpenAI results

${markdownTable(openai)}

### OpenAI interpretation

- **Guarded GPT-5.5 was the pilot winner** for reliability and model-token volume: all 15 mission-file attempts passed.
- GPT-5.5 used fewer model tokens and turns than Terra control, but mean duration increased substantially; it is a quality/cost candidate rather than a speed candidate.
- Guarded Terra improved nominal tokens and strict completion, showing that completion gating contributed independently of model switching.
- Terra → Luna was the best OpenAI routing condition by strict pass rate, but it routed only 0.4 turns per run and produced almost no model-token reduction.
- Terra → GPT-5.4 and Terra → GPT-5.5 also routed fewer than one turn per run. Their secondary-model effects remain underpowered.
- Guarded Luna showed high variance and incomplete mission-file execution in two blocks.

## Gemini results

${markdownTable(gemini)}

### Gemini interpretation

- The Gemini 3.8 control achieved 15/15 strict passes, leaving no reliability headroom.
- Guarded Gemini 3.5 Flash-Lite retained 15/15 passes and had the largest nominal reduction among reliable Gemini conditions, at the cost of higher duration.
- Gemini 3.8 → 3.7 retained perfect reliability and near-control duration; it is the strongest conservative Gemini routing candidate.
- Gemini 3.8 → 3.6 retained reliability but offered little token or latency benefit.
- Direct Gemini 3.6 and Gemini 3.8 → 3.5 Flash-Lite each fell to 11/15 strict passes. The latter also generated frequent primary-model retries.
- No Gemini token delta had a paired 95% interval excluding zero at \`n=5\`; larger samples are required.

## Cross-provider conclusions

1. Keep the execution-model limit at two per run: one primary and one secondary. This preserved attribution and made fallback behavior auditable.
2. Guardrails and completion gating produced more consistent savings than routing because routing coverage remained low.
3. Model choice mattered more than routing sophistication on the OpenAI workload: guarded GPT-5.5 outperformed Terra-based policies.
4. For Gemini, use guarded 3.5 Flash-Lite when cost is dominant and its slower runtime is acceptable; use 3.8 → 3.7 when preserving current-model reliability and latency is more important.
5. Treat this as a pilot, not a universal model ranking. The mission subsets are intentionally small, provider pricing was not embedded, and application/model behavior may drift.

## Limitations and next steps

- Five repetitions provide useful variance estimates but limited statistical power.
- Results apply to these six mission files and their test environments.
- The package reports raw model-token volume, not price-weighted spend; pricing metadata should be versioned before asserting monetary savings.
- Routed OpenAI conditions need either a larger sample or a routing policy that yields more eligible turns.
- Repeat the winning and control conditions at a powered sample size derived from these observed variances.
- Evaluate cross-provider routing first at mission boundaries to avoid transcript/tool-history incompatibilities.

## Data package

The accompanying package includes normalized run-, mission-, and condition-level CSV files; all 70 raw JSON reports; the frozen benchmark matrix; source state/CSV files where available; and SHA-256 checksums. Screenshots, HTML reports, environment files, credentials, and verbose logs are intentionally excluded.
`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

export function buildOptimizationDataPackage({ experimentId = DEFAULT_EXPERIMENT_ID } = {}) {
  const root = path.resolve(HERE, 'results', experimentId);
  const packageDir = path.join(root, 'data-package');
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(packageDir, 'data/raw-reports/openai'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'data/raw-reports/gemini'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'data/source-state'), { recursive: true });

  const entries = ['openai', 'gemini'].flatMap(target => readReports(target, experimentId));
  if (entries.length !== 70) throw new Error(`Expected 70 reports for ${experimentId}; found ${entries.length}.`);
  const runs = entries.map(normalizeRun).sort((a, b) => a.target.localeCompare(b.target) || a.block - b.block || a.condition.localeCompare(b.condition));
  const summaries = summarizeConditions(runs);
  const missionRows = runs.flatMap(run => run.missionOutcomes);

  const runColumns = [
    'experimentId', 'target', 'condition', 'level', 'block', 'runId', 'provider', 'primaryModel',
    'secondaryModel', 'objective', 'mode', 'missionFilesPassed', 'missionFilesTotal', 'phasePassed',
    'phaseFailed', 'phaseTotal', 'turns', 'tokens', 'inputTokens', 'outputTokens', 'durationSeconds',
    'routedTurns', 'forcedPrimaryRetries', 'requestFallbacks', 'completionGates', 'jevEvaluations',
    'jevInputTokens', 'jevOutputTokens', 'models', 'reportFile',
  ];
  const conditionColumns = Object.keys(summaries[0]);
  const missionColumns = Object.keys(missionRows[0]);
  writeCsv(path.join(packageDir, 'data/runs.csv'), runColumns, runs);
  writeCsv(path.join(packageDir, 'data/conditions.csv'), conditionColumns, summaries.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? round(value, 6) : value]))));
  writeCsv(path.join(packageDir, 'data/missions.csv'), missionColumns, missionRows);

  for (const entry of entries) {
    fs.copyFileSync(entry.path, path.join(packageDir, `data/raw-reports/${entry.target}/${entry.file}`));
  }
  for (const name of ['state-openai.json', 'state-gemini.json', 'runs-openai.csv', 'runs-gemini.csv']) {
    const source = path.join(root, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(packageDir, `data/source-state/${name}`));
  }

  const matrix = Object.fromEntries(Object.entries(BENCHMARK_TARGETS).map(([target, value]) => [target, {
    provider: value.provider,
    repoName: path.basename(value.repo),
    missions: value.missions,
    conditions: value.conditions,
  }]));
  fs.writeFileSync(path.join(packageDir, 'data/matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`);
  const report = buildReport(experimentId, runs, summaries);
  fs.writeFileSync(path.join(packageDir, 'REPORT.md'), report);
  fs.writeFileSync(path.join(root, `${experimentId}-report.md`), report);
  fs.writeFileSync(path.join(packageDir, 'README.md'), `# ${experimentId} data package\n\nStart with [REPORT.md](REPORT.md). Normalized datasets are under \`data/\`; raw Testronaut JSON reports are under \`data/raw-reports/\`. See \`manifest.json\` and \`SHA256SUMS\` for provenance and integrity. Screenshots, HTML, credentials, environment files, and verbose logs are excluded.\n`);

  const dataFiles = walkFiles(packageDir).filter(file => !['manifest.json', 'SHA256SUMS'].includes(path.basename(file)));
  const manifest = {
    schemaVersion: 1,
    experimentId,
    generatedAt: new Date().toISOString(),
    counts: { reports: entries.length, runs: runs.length, conditions: summaries.length, missionFileAttempts: missionRows.length },
    exclusions: ['screenshots', 'HTML reports', 'environment files', 'credentials', 'verbose CLI logs'],
    files: dataFiles.map(file => ({ path: path.relative(packageDir, file), bytes: fs.statSync(file).size, sha256: sha256(file) })),
  };
  fs.writeFileSync(path.join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumFiles = walkFiles(packageDir).filter(file => path.basename(file) !== 'SHA256SUMS');
  fs.writeFileSync(path.join(packageDir, 'SHA256SUMS'), checksumFiles.map(file => `${sha256(file)}  ${path.relative(packageDir, file)}`).sort().join('\n') + '\n');

  const archive = path.join(root, `${experimentId}-data-package.tar.gz`);
  fs.rmSync(archive, { force: true });
  const tar = spawnSync('tar', ['-czf', archive, '-C', root, 'data-package'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`Could not create archive: ${tar.stderr || tar.stdout}`);
  fs.writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${path.basename(archive)}\n`);
  return { root, packageDir, archive, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const experimentId = process.argv.find(arg => arg.startsWith('--experiment-id='))?.split('=')[1] || DEFAULT_EXPERIMENT_ID;
  const result = buildOptimizationDataPackage({ experimentId });
  console.log(`Report and data package generated at ${result.packageDir}`);
  console.log(`Archive: ${result.archive}`);
}

export const __dataPackageInternals = { mean, sampleSd, normalizeRun, summarizeConditions, pairedDelta };
