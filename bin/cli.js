#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeTestronautProject } from './init.js';
import { createWelcomeMission } from './createWelcomeMission.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const missionsDir = path.resolve(process.cwd(), 'missions');

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
      await missionsModule.executeMission(); // or call a named export like `executeMissions()`
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
