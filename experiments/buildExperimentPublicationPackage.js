#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_TARGETS } from './optimizationBenchmark.js';
import { CROSS_PROVIDER_CONDITIONS } from './crossProviderBenchmark.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLICATION_ID = 'jev-optimization-experiments-2026-10';
const RESULTS = path.join(HERE, 'results');
const OUTPUT = path.join(RESULTS, PUBLICATION_ID);
const PACKAGE = path.join(OUTPUT, 'data-package');

function csvEscape(value) {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, columns, rows) {
  fs.writeFileSync(file, `${columns.join(',')}\n${rows.map(row => columns.map(column => csvEscape(row[column])).join(',')).join('\n')}\n`);
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function round(value, digits = 1) { return Number(value.toFixed(digits)); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function readCrossProvider() {
  const stateFile = path.join(RESULTS, 'cross-provider-pilot-v1/state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const runs = Object.values(state.runs).map(run => {
    if (run.status !== 'completed' || !run.reportPath || !run.metrics) throw new Error(`Incomplete cross-provider run: ${run.key}`);
    const report = JSON.parse(fs.readFileSync(run.reportPath, 'utf8'));
    const selectorUsage = run.selection?.evaluation?.usage || {};
    return {
      experimentId: state.experimentId,
      key: run.key,
      block: run.block,
      condition: run.id,
      mission: run.unit,
      candidateModels: run.candidates.map(item => `${item.provider}/${item.model}`).join('|'),
      selectedProvider: run.selection.selected.provider,
      selectedModel: run.selection.selected.model,
      selectedBy: run.selection.selectedBy,
      selectionScore: run.selection.score,
      strictPass: run.metrics.failed === 0,
      phasePassed: run.metrics.passed,
      phaseFailed: run.metrics.failed,
      turns: run.metrics.turns,
      modelTokens: run.metrics.tokens,
      jevInputTokens: run.metrics.jevInputTokens,
      jevOutputTokens: run.metrics.jevOutputTokens,
      selectorInputTokens: Number(selectorUsage.input_tokens || 0),
      selectorOutputTokens: Number(selectorUsage.output_tokens || 0),
      durationSeconds: (new Date(report.endTime) - new Date(report.startTime)) / 1000,
      runId: report.runId,
      cliVersion: report.cli?.version,
    };
  });
  const conditions = CROSS_PROVIDER_CONDITIONS.map(condition => {
    const values = runs.filter(run => run.condition === condition.id);
    return {
      condition: condition.id,
      type: condition.id.startsWith('c') ? 'fixed-control' : 'cross-provider-treatment',
      candidates: condition.candidates.map(item => `${item.provider}/${item.model}`).join('|'),
      n: values.length,
      strictPassed: values.filter(run => run.strictPass).length,
      strictPassRate: round(values.filter(run => run.strictPass).length / values.length, 4),
      meanModelTokens: round(mean(values.map(run => run.modelTokens)), 0),
      meanJevTokens: round(mean(values.map(run => run.jevInputTokens + run.jevOutputTokens)), 0),
      meanSelectorTokens: round(mean(values.map(run => run.selectorInputTokens + run.selectorOutputTokens)), 0),
      meanDurationSeconds: round(mean(values.map(run => run.durationSeconds)), 1),
      selections: Object.fromEntries([...new Set(values.map(run => run.selectedModel))].map(model => [model, values.filter(run => run.selectedModel === model).length])),
    };
  });
  return { state, runs, conditions };
}

function crossTable(conditions) {
  const rows = conditions.map(row => `| ${row.condition} | ${row.type} | ${row.strictPassed}/${row.n} (${Math.round(row.strictPassRate * 100)}%) | ${row.meanModelTokens.toLocaleString()} | ${row.meanJevTokens.toLocaleString()} | ${row.meanSelectorTokens.toLocaleString()} | ${row.meanDurationSeconds}s |`);
  return ['| Condition | Design | Strict pass | Mean model tokens | Mean in-mission Jev tokens | Mean selector tokens | Mean duration |', '|---|---|---:|---:|---:|---:|---:|', ...rows].join('\n');
}

function optimizationMatrix() {
  return Object.fromEntries(Object.entries(BENCHMARK_TARGETS).map(([target, value]) => [target, {
    provider: value.provider,
    missions: value.missions,
    conditions: value.conditions,
  }]));
}

function reportMarkdown(cross) {
  return `# Jev optimization experiments: guardrails and model routing

Publication package: \`${PUBLICATION_ID}\`  
Generated: ${new Date().toISOString()}  
CLI baseline: Testronaut 1.11.0

## Executive summary

Two blocked experiments evaluated Jev-assisted browser-testing optimization. The first contained **70 aggregate runs and 210 mission-file attempts** across OpenAI and Gemini workloads. The second contained **120 isolated mission executions** testing fixed-model controls and mission-boundary cross-provider selection. All conditions used five randomized blocks.

The most defensible result is that **Jev guardrails are useful without model switching**. Guarded GPT-5.5 completed 15/15 OpenAI mission-file attempts and used 13.7% fewer model tokens than the unguarded Terra control, with a paired 95% interval of -19.8% to -7.5%. Guarded Terra also improved strict completion and nominally reduced tokens. On Gemini, guardrails preserved the already-perfect reliability of Gemini 3.8 Flash with a smaller nominal token reduction.

Same-provider routing is promising but not yet broadly proven. Gemini 3.8 → 3.7 retained 15/15 strict passes with a nominal 5.1% token reduction and similar duration. OpenAI routing coverage was below one routed turn per aggregate run, making attribution underpowered.

Mission-boundary cross-provider routing did **not** reduce token volume. The strongest fixed control, guarded GPT-5.5, achieved 15/15 strict passes at 87,422 mean model tokens per isolated mission. GPT-5.5 ↔ Gemini 3.5 Flash-Lite also achieved 15/15, but required 104,897 mean model tokens. Jev's extra selector call averaged only about 621–724 tokens, so selector overhead was not the cause; the model choices themselves produced longer executions.

## Experiment 1: optimization ladder

| Provider | Condition | Strict pass | Mean model tokens | Paired token delta vs control | Mean duration |
|---|---|---:|---:|---:|---:|
| OpenAI | Terra control | 5/15 (33%) | 300,073 | baseline | 293s |
| OpenAI | Guarded GPT-5.5 | **15/15 (100%)** | **258,635** | **-13.7% [-19.8, -7.5]** | 416s |
| OpenAI | Guarded Terra | 8/15 (53%) | 275,114 | -8.2% [-18.0, 1.7] | 328s |
| OpenAI | Terra → Luna | 11/15 (73%) | 296,299 | -1.1% [-12.1, 9.9] | 376s |
| Gemini | 3.8 control | **15/15 (100%)** | 491,428 | baseline | 529s |
| Gemini | Guarded 3.5 Flash-Lite | **15/15 (100%)** | **427,766** | -12.0% [-34.7, 10.8] | 582s |
| Gemini | 3.8 → 3.7 | **15/15 (100%)** | 461,256 | -5.1% [-19.7, 9.5] | 538s |

The table highlights decision-relevant conditions; complete condition, run, and mission tables are included in \`data/optimization/\`.

## Experiment 2: cross-provider mission-boundary routing

${crossTable(cross.conditions)}

Jev chose a Gemini candidate for 50 of 60 treatment missions. That bias was not aligned with the observed workload: GPT-5.5 was the only fixed model with perfect strict completion, and it used the fewest mean model tokens. The file-transfer mission was particularly discriminating: GPT-5.5 passed 5/5, Terra and Gemini 3.8 passed 0/5, and Gemini 3.5 Flash-Lite passed 3/5 in their fixed controls.

## Product implications

1. Stabilize guardrail-only operation: completion/evidence checks, fail-open behavior, primary-model continuity, and explicit telemetry.
2. Keep execution-model routing beta and opt-in. Limit a run to one primary and one compatible same-provider secondary.
3. Treat Gemini 3.8 → 3.7 as a conservative candidate for a larger confirmation study, not a universal default.
4. Do not ship zero-shot cross-provider selection as an optimization default.
5. Next test history-informed routing using versioned per-model reliability, tokens, latency, and price, with a reliability floor and cold-start fallback.

## Methodology and interpretation

- Both experiments used five randomized blocks (\`n=5\` per condition design).
- Strict success required every expected phase in a mission file to exist and pass.
- Experiment 1 aggregate runs each invoked three mission files. Experiment 2 intentionally isolated each mission to make mission-boundary selection attributable.
- Model tokens and Jev tokens are reported separately. Token counts are not price-weighted spend.
- Experiment 1 paired intervals use a two-sided 95% Student-t interval with four degrees of freedom.
- Six initial Gemini 3.8 requests in experiment 2 returned provider HTTP 500 errors. The resumable benchmark reran those incomplete units using their persisted selections; the final dataset contains 120 completed reports.
- Results describe these repositories, missions, model versions, dates, and provider behavior. They are not universal model rankings.

## Data and privacy

This public package contains normalized measurements, matrices, methodology, and checksums. It intentionally excludes raw browser events, DOM content, screenshots, HTML reports, environment files, credentials, absolute report paths, and verbose logs. The private source reports remain the audit source for the normalized rows.
`;
}

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function buildPublicationPackage() {
  const optimizationPackage = path.join(RESULTS, 'optimization-pilot-v1/data-package/data');
  if (!fs.existsSync(optimizationPackage)) throw new Error('Build optimization-pilot-v1 package first with npm run benchmark:package');
  const cross = readCrossProvider();
  fs.mkdirSync(path.join(PACKAGE, 'data/optimization'), { recursive: true });
  fs.mkdirSync(path.join(PACKAGE, 'data/cross-provider'), { recursive: true });

  for (const name of ['conditions.csv', 'missions.csv', 'runs.csv', 'matrix.json']) {
    fs.copyFileSync(path.join(optimizationPackage, name), path.join(PACKAGE, `data/optimization/${name}`));
  }
  const crossColumns = Object.keys(cross.runs[0]);
  writeCsv(path.join(PACKAGE, 'data/cross-provider/runs.csv'), crossColumns, cross.runs);
  writeCsv(path.join(PACKAGE, 'data/cross-provider/conditions.csv'), Object.keys(cross.conditions[0]), cross.conditions);
  fs.writeFileSync(path.join(PACKAGE, 'data/cross-provider/matrix.json'), `${JSON.stringify({
    experimentId: cross.state.experimentId,
    repetitions: cross.state.repetitions,
    conditions: CROSS_PROVIDER_CONDITIONS,
    missions: [...new Set(cross.runs.map(run => run.mission))],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(PACKAGE, 'data/combined-matrix.json'), `${JSON.stringify({ optimization: optimizationMatrix(), crossProvider: CROSS_PROVIDER_CONDITIONS }, null, 2)}\n`);

  const report = reportMarkdown(cross);
  fs.writeFileSync(path.join(PACKAGE, 'REPORT.md'), report);
  fs.writeFileSync(path.join(PACKAGE, 'README.md'), `# Jev optimization experiment publication package\n\nStart with [REPORT.md](REPORT.md). The normalized, publication-safe datasets are in \`data/optimization/\` and \`data/cross-provider/\`. See [DATA_DICTIONARY.md](DATA_DICTIONARY.md) for field definitions and \`SHA256SUMS\` for integrity.\n`);
  fs.writeFileSync(path.join(PACKAGE, 'DATA_DICTIONARY.md'), `# Data dictionary\n\n## Optimization ladder\n\n- \`runs.csv\`: one aggregate CLI run (three mission files) per row.\n- \`missions.csv\`: one expected mission-file outcome per aggregate run.\n- \`conditions.csv\`: condition-level means, paired deltas, intervals, routing, and completion-gate counts.\n- \`matrix.json\`: frozen provider, mission, and condition definitions.\n\n## Cross-provider benchmark\n\n- \`runs.csv\`: one isolated mission execution per row. \`strictPass\` means all reported phases passed. Selector tokens are separated from in-mission Jev tokens.\n- \`conditions.csv\`: condition-level strict completion, mean token, selection, and duration summaries.\n- \`matrix.json\`: frozen candidates, missions, and repetition count.\n\nEmpty secondary models indicate fixed-model conditions. Durations are wall-clock seconds. Token fields are raw token volume, not price-weighted cost.\n`);

  const filesBeforeManifest = walk(PACKAGE)
    .filter(file => !['manifest.json', 'SHA256SUMS'].includes(path.basename(file)))
    .map(file => ({ path: path.relative(PACKAGE, file), bytes: fs.statSync(file).size, sha256: sha256(file) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schemaVersion: 1,
    publicationId: PUBLICATION_ID,
    generatedAt: new Date().toISOString(),
    cliBaseline: '1.11.0',
    experiments: [
      { id: 'optimization-pilot-v1', aggregateRuns: 70, missionFileAttempts: 210 },
      { id: 'cross-provider-pilot-v1', isolatedMissionRuns: 120 },
    ],
    privacyExclusions: ['raw browser events and DOM', 'screenshots', 'HTML reports', 'environment files', 'credentials', 'absolute report paths', 'verbose logs'],
    files: filesBeforeManifest,
  };
  fs.writeFileSync(path.join(PACKAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumFiles = walk(PACKAGE).filter(file => path.basename(file) !== 'SHA256SUMS').sort();
  fs.writeFileSync(path.join(PACKAGE, 'SHA256SUMS'), `${checksumFiles.map(file => `${sha256(file)}  ${path.relative(PACKAGE, file)}`).join('\n')}\n`);

  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.copyFileSync(path.join(PACKAGE, 'REPORT.md'), path.join(OUTPUT, `${PUBLICATION_ID}-report.md`));
  const archive = path.join(OUTPUT, `${PUBLICATION_ID}-data-package.tar.gz`);
  const tar = spawnSync('tar', ['-czf', archive, '-C', OUTPUT, 'data-package'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(tar.stderr || 'Could not create archive');
  fs.writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${path.basename(archive)}\n`);
  return { output: OUTPUT, package: PACKAGE, archive, report: path.join(OUTPUT, `${PUBLICATION_ID}-report.md`) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildPublicationPackage());
}
