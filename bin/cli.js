#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeTestronautProject } from './init.js';
import { createWelcomeMission } from './createWelcomeMission.js';
import { generateHtmlReport } from '../tools/generateHtmlReport.js';
import inquirer from 'inquirer';
import fetch from 'node-fetch';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// const apiBase = `http://localhost:3002` //
const apiBase = 'http://api.testronaut.app'; // Replace with your actual API base URL


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

// helpers near top of cli.js
async function parseJsonSafe(res, urlLabel) {
  const text = await res.text(); // read once
  let data = null;
  // console.log('response text: ', text);
  // console.log('urlLabel: ', urlLabel);
  // console.log('res', res);
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    // bubble up useful diagnostics
    const snippet = text?.slice(0, 300) || '(no body)';
    throw new Error(`${urlLabel} ${res.status} ${res.statusText}: ${snippet}`);
  }
  if (!data) {
    throw new Error(`${urlLabel} returned no JSON body`);
  }
  return data;
}


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
    const response = await fetch(`${apiBase}/api/user/cli`, {  // Replace with your actual URL
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


  // 1) Find latest report JSON
  const reportDir = path.resolve(process.cwd(), 'missions/mission_reports');
  const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.error('❌ No report files found.');
    process.exit(1);
  }
  files.sort((a, b) => parseInt(b.split('_')[1]) - parseInt(a.split('_')[1]));
  const latestReportFile = files[0];
  const latestReportPath = path.join(reportDir, latestReportFile);
  const reportJson = fs.readFileSync(latestReportPath, 'utf8');

  // 2) Upload report FIRST and capture its ID
  console.log(`🛰️  Uploading report: ${latestReportFile}`);
  let savedReportId; // <-- make sure this is defined before screenshot code
  try {
    const res = await fetch(`${apiBase}/api/user/cli/${sessionToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reportJson,
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || res.statusText);

    // Your API returns { message, report: savedReport }
    savedReportId = data?.report?._id;
    if (!savedReportId) {
      // Fallback: use filename stem (not ideal, but prevents a hard stop)
      savedReportId = path.basename(latestReportFile, '.json');
      console.warn(`⚠️  Server response lacked report._id, falling back to ${savedReportId}`);
    }
    console.log('✅ Report uploaded:', savedReportId);
  } catch (err) {
    console.error('❌ Failed to upload the report:', err.message || err);
    process.exit(1);
  }

  // 3) Now find the fixed 'screenshots' folder next to JSON
  const screenshotsDir = path.join(reportDir, 'screenshots');
  if (!fs.existsSync(screenshotsDir) || !fs.statSync(screenshotsDir).isDirectory()) {
    console.log('ℹ️  No screenshots directory found. Done.');
    return;
  }

  // 4) Collect and sort images by timestamp in filename
  const parseScreenshotTimestamp = (name) => {
    const m = name.match(/^screenshot_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/i);
    if (!m) return Number.MAX_SAFE_INTEGER;
    const [_, Y, M, D, h, mnt, s, ms] = m;
    return Date.UTC(+Y, +M - 1, +D, +h, +mnt, +s, +ms);
  };

  let imageFiles = fs
    .readdirSync(screenshotsDir)
    .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
    .sort((a, b) => parseScreenshotTimestamp(a) - parseScreenshotTimestamp(b));

  if (!imageFiles.length) {
    console.log('ℹ️  Screenshots directory is empty. Done.');
    return;
  }

  console.log(`🖼️  Uploading ${imageFiles.length} screenshot(s) from ${path.relative(process.cwd(), screenshotsDir)}`);

  // 5) Upload screenshots (uses savedReportId captured above)
  const guessMime = p => {
    const e = path.extname(p).toLowerCase();
    if (e === '.png') return 'image/png';
    if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
    if (e === '.webp') return 'image/webp';
    if (e === '.gif') return 'image/gif';
    return 'application/octet-stream';
  };
  const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

  const failures = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const f = imageFiles[i];
    const filePath = path.join(screenshotsDir, f);
    const stepIndex = i;

    process.stdout.write(`   ➜ ${f} (step ${stepIndex}) … `);
    try {
      const buf = fs.readFileSync(filePath);
      const stat = fs.statSync(filePath);
      const mime = guessMime(filePath);
      const hash = sha1(buf);

      // START
      // console.log('     uploading', filePath);
      // console.log(`   ➜ hope it goes well…`);
      // console.log(` the fetch url is: ${apiBase}/api/user/cli/${sessionToken}/uploads/start`);
      const startRes = await fetch(`${apiBase}/api/user/cli/${sessionToken}/uploads/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: savedReportId, stepIndex, fileName: path.basename(filePath), mime, size: stat.size, sha1: hash }),
      });
      const start = await parseJsonSafe(startRes, 'uploads/start');
      if (!start.putUrl || !start.key) throw new Error(`uploads/start missing putUrl/key`);

      // PUT
      // console.log(`     uploading ${stat.size} bytes to storage…`);
      const putRes = await fetch(start.putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': mime, 'Content-Length': String(stat.size) },
        body: buf,
      });
      if (!putRes.ok) {
        const text = await putRes.text().catch(() => '');
        throw new Error(`${putRes.status} ${text}`);
      }

      // FINISH
      // console.log(`     finalizing upload…`);
      const finishRes = await fetch(`${apiBase}/api/user/cli/${sessionToken}/uploads/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          reportId: savedReportId, 
          stepIndex, 
          key: start.key, 
          mime, 
          bytes: stat.size, 
          sha1: hash, 
          originalFileName: path.basename(filePath), 
        }),
      });
      const finish = await parseJsonSafe(finishRes, 'uploads/finish');
      if (!finish.ok) throw new Error(`uploads/finish responded ok=false`);

      process.stdout.write('ok\n');
    } catch (err) {
      process.stdout.write('FAIL\n');
      failures.push({ file: f, error: err.message || String(err) });
    }
  }

  if (failures.length) {
    console.log('\n⚠️  Some screenshots failed to upload:');
    for (const f of failures) console.log(`   - ${f.file}: ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log('✅ All screenshots uploaded.');
  }
}
