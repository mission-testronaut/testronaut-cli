#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeTestronautProject } from './init.js';
import { createWelcomeMission } from './createWelcomeMission.js';
import { generateHtmlReport } from '../tools/generateHtmlReport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const missionsDir = path.resolve(process.cwd(), 'missions');

const allResults = [];
const runId = `run_${Date.now()}`;
const startTime = new Date();

const HELP_TEXT = `
🧑‍🚀 testronaut - Autonomous Agent Mission Runner

Usage:
  npx testronaut                 Run all missions in the ./missions directory
  npx testronaut <file>         Run a specific mission file (e.g., login.mission.js)

Options:
  --init                    Scaffold project folders and a welcome mission
  --help                    Show this help message

Examples:
  npx testronaut
  npx testronaut login.mission.js
  npx testronaut --init
`;


if (args.includes('--init')) {
  await initializeTestronautProject();
  await createWelcomeMission();
  process.exit(0);
}

if (args.includes('--help')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (!fs.existsSync(missionsDir)) {
  console.error('❌ No `missions` directory found.');
  process.exit(1);
}

const runFile = async (filePath) => {
  try {
    const modulePath = path.resolve(missionsDir, filePath);
    const missionsModule = await import(`file://${modulePath}`);

    if (typeof missionsModule.executeMission === 'function') {
      const result = await missionsModule.executeMission();
      allResults.push({
        file: filePath,
        result
      });
    }
  } catch (err) {
    console.error(`❌ Error running mission: ${filePath}`);
    console.error(err);
  }
};

if (args.length > 0) {
  // Run specific file(s)
  for (const file of args) {
    await runFile(file);
  }
} else {
  // Run all *.mission.js files
  const files = fs.readdirSync(missionsDir).filter(f => f.endsWith('.mission.js'));
  for (const file of files) {
    await runFile(file);
  }
}

const endTime = new Date();

const flatMissions = allResults.flatMap(entry => {
  const result = entry.result;
  const missions = Array.isArray(result) ? result : [result]; // normalize
  return missions.map(m => ({
    ...m,
    file: entry.file
  }));
});


const report = {
  runId,
  startTime: startTime.toISOString(),
  endTime: endTime.toISOString(),
  summary: {
    totalMissions: flatMissions.length,
    passed: flatMissions.filter(m => m.status === 'passed').length,
    failed: flatMissions.filter(m => m.status === 'failed').length,
  },
  missions: flatMissions
};

const outputDir = './missions/mission_reports';
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(`${outputDir}/${runId}.json`, JSON.stringify(report, null, 2));
generateHtmlReport(report, `${outputDir}/${runId}.html`);