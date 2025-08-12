#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeTestronautProject } from './init.js';
import { createWelcomeMission } from './createWelcomeMission.js';
import { generateHtmlReport } from '../tools/generateHtmlReport.js';
import inquirer from 'inquirer';
import fetch from 'node-fetch';

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
  npx testronaut login          Log in and store session token
  npx testronaut upload         Upload the most recent report JSON

Options:
  --init                    Scaffold project folders and a welcome mission
  --help                    Show this help message

Examples:
  npx testronaut
  npx testronaut login
  npx testronaut upload
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

// Handle the login command
if (args.includes('login')) {
  await handleLogin();
  process.exit(0);
}

// Handle the upload command
if (args.includes('upload')) {
  await uploadReport();
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

// Function to handle login and store session token
async function handleLogin() {
  // Check if API key is provided as an argument
  let apiKey = args.find(arg => arg.startsWith('--apiKey='))?.split('=')[1];

  // If API key is not provided, prompt the user for it
  if (!apiKey) {
    const responses = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your API key:',
        mask: '*' 
      }
    ]);
    apiKey = responses.apiKey;
  }

  // Create URLSearchParams to send as x-www-form-urlencoded
  const formData = new URLSearchParams();
  formData.append('apiKey', apiKey);
  console.log('🔑 Authenticating with API key...');

  // Call your authentication endpoint to get a session token
  try {
    const response = await fetch('http://testronaut.app/api/user/cli', {  // Replace with your actual URL
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: formData.toString(),
    });

    const data = await response.json();

    if (data.error) {
      console.error('❌ Authentication failed:', data.error);
      process.exit(1);
    }

    // Define the config path
    const configPath = path.resolve(process.cwd(), 'testronaut-config.json');
    
    // Read the existing config file
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    // Overwrite or add the sessionToken field
    config.sessionToken = data.sessionToken;

    // Write the updated config back to testronaut-config.json
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log('✅ Login successful! Session token saved to testronaut-config.json.');
  } catch (error) {
    console.error('❌ Error during login:', error);
    process.exit(1);
  }
}

// Upload the most recent report
async function uploadReport() {
  const configPath = path.resolve(process.cwd(), 'testronaut-config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ Configuration file not found.');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const sessionToken = config.sessionToken;

  if (!sessionToken) {
    console.error('❌ No session token found.');
    process.exit(1);
  }

  // Get the most recent report from the 'missions/mission_reports/' directory
  const reportDir = path.resolve(process.cwd(), 'missions/mission_reports');
  const files = fs.readdirSync(reportDir).filter(file => file.endsWith('.json'));

  if (files.length === 0) {
    console.error('❌ No report files found.');
    process.exit(1);
  }

  // Sort files by timestamp (most recent first)
  files.sort((a, b) => parseInt(b.split('_')[1]) - parseInt(a.split('_')[1]));
  const latestReport = path.join(reportDir, files[0]);

  // Read the content of the most recent report
  const reportData = fs.readFileSync(latestReport, 'utf8');

  // Upload the report using the session token
  try {
    const response = await fetch(`http://testronaut.app/api/user/cli/${sessionToken}`, { // Replace with your API endpoint
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: reportData,  // Sending the report JSON as the request body
    });

    const data = await response.json();
    if (data.error) {
      console.error('❌ Failed to upload the report:', data.error);
    } else {
      console.log('✅ Report uploaded successfully!');
    }
  } catch (error) {
    console.error('❌ Error during upload:', error);
  }
}