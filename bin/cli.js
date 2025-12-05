#!/usr/bin/env node

/**
 * cli.js
 * -------
 * Purpose:
 *   Single entry point for the Testronaut CLI:
 *   - Parses flags (e.g., --model, --turns, --init, help).
 *   - Runs mission files (single or all), aggregates results, and writes HTML/JSON reports.
 *   - Provides subcommands: login, upload (report + screenshots), serve/view (static file server).
 *
 * Key flags:
 *   --model <id> / --model=<id>         → sets TESTRONAUT_MODEL env (wins over config file)
 *   --turns <n> / --turns=<n>           → sets TESTRONAUT_TURNS env (wins over config file)
 *   --init                               → scaffolds project + optional Playwright browsers
 *   --help                               → prints help
 *
 * Notable helpers (defined below):
 *   parseJsonSafe(res, label)            → tolerant JSON parse with good error messages
 *   pkgManagerForCwd(cwd)                → detects npm/pnpm/yarn/bun
 *   hasAny(modNames)                     → “do we have at least one of these deps?” (ESM-safe)
 *   installDev(pm, pkg)                  → dev-install a package with the detected package manager
 *   ensurePlaywrightInstalled()          → install @playwright/test and browsers (skippable in CI)
 *   guessMimeType(p)                     → static server content types
 *   safeJoin(root, relUrlPath)           → path traversal protection for static server
 *   findLatestReportPair(reportDir)      → find latest run_<ts>.html (+ matching .json if present)
 *   serveLatestReport()                  → read-only file server for most recent HTML report
 *
 * Test strategy:
 *   To test pure helpers without running the whole CLI, we export a tiny test bundle:
 *     export const __test__ = { guessMimeType, safeJoin, findLatestReportPair, pkgManagerForCwd }
 *   See tests in tests/toolsTests/cli.helpers.test.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeTestronautProject } from './init.js';
import { createWelcomeMission } from './createWelcomeMission.js';
import { generateHtmlReport } from '../tools/generateHtmlReport.js';
import inquirer from 'inquirer';
import fetch from 'node-fetch';
import crypto from 'crypto';
import http from 'http';
import { exec as execCmd } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execCmd);
import url from 'url';
import { ensureBrowsers } from '../tools/playwrightSetup.js';
import { discoverMissionFiles } from '../core/missionDiscovery.js';

// Keep PW browsers inside the project to avoid global cache skew
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const TMP_DIR = path.resolve('./missions/tmp');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// const apiBase = `http://localhost:3002` //
const apiBase = 'http://api.testronaut.app'; // Replace with your actual API base URL


const args = process.argv.slice(2);

/**
 * Read a JSONL steps file into an array of objects.
 * @param {string} p
 * @returns {object[]|null}
 */
function readJsonlSteps(p) {
  if (!p || !fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* ignore bad lines */ }
  }
  return parsed;
}

/**
 * Merge duplicate turns without losing information.
 * Strategy:
 *  - Keep the latest **non-empty** version for a given (turn,retry) pair
 *  - If both are non-empty, keep the later one (last write wins)
 *  - Preserve original order by line index as a tiebreaker
 *
 * @param {Array} steps
 * @returns {Array}
 */
function mergeDuplicateTurns(steps) {
  const out = [];
  const byKey = new Map(); // composite key -> index in out
  for (const s of steps) {
    const turn = Number.isFinite(s.turn) ? s.turn : out.length;
    const attempt = Number.isFinite(s.retryAttempt) ? s.retryAttempt : 1;
    const hasEvents = Array.isArray(s.events) && s.events.length > 0;
    const key = `${turn}::${attempt}`;

    if (!byKey.has(key)) {
      out.push(s);
      byKey.set(key, out.length - 1);
    } else {
      const idx = byKey.get(key);
      const existing = out[idx];
      const existingHasEvents = Array.isArray(existing.events) && existing.events.length > 0;
      // Prefer the one with events; if both have events, prefer the newer (s)
      if (!existingHasEvents && hasEvents) {
        out[idx] = s;
      } else if (existingHasEvents && hasEvents) {
        out[idx] = s;
      } else {
        // both empty or both sparse — keep latest
        out[idx] = s;
      }
    }
  }
  // stable sort by `turn` then `retryAttempt`, then by original order
  out.sort((a, b) => {
    const ta = a.turn ?? 0;
    const tb = b.turn ?? 0;
    if (ta !== tb) return ta - tb;
    const ra = Number.isFinite(a.retryAttempt) ? a.retryAttempt : 1;
    const rb = Number.isFinite(b.retryAttempt) ? b.retryAttempt : 1;
    if (ra !== rb) return ra - rb;
    return 0;
  });
  return out;
}

// Expose a small bundle for unit tests (helper-only; not the CLI flow)
export const __test__ = {
  guessMimeType,
  safeJoin,
  findLatestReportPair,
  mergeDuplicateTurns,
  readJsonlSteps,
};

// Look for --model=<id> or --model <id>
let modelOverride;
const modelFlagIndex = args.findIndex(a => a === '--model' || a.startsWith('--model='));
if (modelFlagIndex >= 0) {
  if (args[modelFlagIndex].includes('=')) {
    modelOverride = args[modelFlagIndex].split('=')[1];
  } else if (args[modelFlagIndex + 1]) {
    modelOverride = args[modelFlagIndex + 1];
  }

  if (modelOverride) {
    process.env.TESTRONAUT_MODEL = modelOverride.trim();
    console.log(`🧠 Model override: ${process.env.TESTRONAUT_MODEL}`);
  }

  // Remove flag & value from args so they don't look like mission filenames
  args.splice(modelFlagIndex, modelOverride ? 2 : 1);
}

// Look for --turns=<n> or --turns <n>
let turnsOverride;
const turnsFlagIndex = args.findIndex(a => a === '--turns' || a.startsWith('--turns='));
if (turnsFlagIndex >= 0) {
  if (args[turnsFlagIndex].includes('=')) {
    turnsOverride = args[turnsFlagIndex].split('=')[1];
  } else if (args[turnsFlagIndex + 1]) {
    turnsOverride = args[turnsFlagIndex + 1];
  }

  if (turnsOverride) {
    const n = Number(turnsOverride.trim());
    if (Number.isFinite(n) && n > 0) {
      process.env.TESTRONAUT_TURNS = String(n);
      console.log(`🎯 Turn override: ${process.env.TESTRONAUT_TURNS}`);
    } else {
      console.warn(`⚠️ Invalid --turns value "${turnsOverride}". Ignoring.`);
    }
  }

  // Remove flag & value so they aren’t treated as filenames
  args.splice(turnsFlagIndex, turnsOverride ? 2 : 1);
}

// Look for --retry_limit / --retry-limit
let retryOverride;
const retryFlagIndex = args.findIndex(a =>
  a === '--retry_limit' ||
  a.startsWith('--retry_limit=') ||
  a === '--retry-limit' ||
  a.startsWith('--retry-limit=')
);
if (retryFlagIndex >= 0) {
  const rawArg = args[retryFlagIndex];
  if (rawArg.includes('=')) {
    retryOverride = rawArg.split('=')[1];
  } else if (args[retryFlagIndex + 1]) {
    retryOverride = args[retryFlagIndex + 1];
  }

  if (retryOverride) {
    const n = Number(retryOverride.trim());
    if (Number.isFinite(n)) {
      const clamped = Math.min(10, Math.max(1, n));
      process.env.TESTRONAUT_RETRY_LIMIT = String(clamped);
      console.log(`🔁 Retry limit override: ${process.env.TESTRONAUT_RETRY_LIMIT} (allowed 1-10)`);
    } else {
      console.warn(`⚠️ Invalid --retry_limit value "${retryOverride}". Ignoring.`);
    }
  }

  // Remove flag & value so they aren’t treated as filenames
  args.splice(retryFlagIndex, retryOverride ? 2 : 1);
}

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
  npx testronaut serve        Serve & open the most recent HTML report (read-only)
  npx testronaut view         Alias of 'serve'

Options:
  --init                    Scaffold project folders and a welcome mission
  --turns=<n>               Override max turns for this run (e.g., --turns=30)
  --help                    Show this help message
  --retry_limit=<n>         Override agent turn retry limits (minimum 1, maximum 10)

Examples:
  npx testronaut
  npx testronaut login
  npx testronaut upload
  npx testronaut serve
  npx testronaut --init
`;

if (args.includes('--init')) {
  await initializeTestronautProject();
  await createWelcomeMission();

  const { default: inquirer } = await import('inquirer');
  const { doPw } = await inquirer.prompt([
    { type: 'confirm', name: 'doPw', message: 'Install Playwright browsers now?', default: true }
  ]);

  if (doPw) {
    // ensure @playwright/test exists so the installer can pin to its version
    const present = await hasAny(['@playwright/test', 'playwright']);
    if (!present) {
      console.log('📦 Installing @playwright/test …');
      const pm = pkgManagerForCwd();
      await installDev(pm, '@playwright/test');
      console.log('✅ @playwright/test installed.');
    }

    // install browsers pinned to local version, project-local cache
    await ensureBrowsers({ browser: 'chromium', withDeps: true });
  }

  console.log(`
✅ Project initialized!

Next steps:
  1. Get an API key from your AI provider
  2. Add it to your .env file
  3. Run your first mission:
       npx testronaut

📚 Docs: https://docs.testronaut.app/docs/guides/cli-auth
  `);

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

// Handle the serve/view command
if (args.includes('serve') || args.includes('view')) {
  await serveLatestReport();
   // Keep process alive until user stops it
  console.log('Press Ctrl+C to stop the server.');
  await new Promise(() => {}); // ✅ never resolves; Ctrl+C will terminate
}

const { root: missionsRoot, files: discoveredMissions } = await discoverMissionFiles({ cwd: process.cwd() });

if (!fs.existsSync(missionsRoot)) {
  console.error(`❌ Missions directory not found: ${path.relative(process.cwd(), missionsRoot)}`);
  process.exit(1);
}

const runFile = async (filePath) => {
  try {
    const modulePath = path.resolve(missionsRoot, filePath);
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
  // Run missions discovered from config (or default behavior)
  for (const file of discoveredMissions) {
    await runFile(file);
  }
}

const endTime = new Date();

const flatMissions = allResults.flatMap(entry => {
  const result = entry.result;
  const missions = Array.isArray(result) ? result : [result];

  return missions.map(m => {
    let steps = m.steps;
    if (m.stepFile && fs.existsSync(m.stepFile)) {
      const fromJsonl = readJsonlSteps(m.stepFile);
      if (fromJsonl && fromJsonl.length) {
        steps = mergeDuplicateTurns(fromJsonl);
      }
    }
    return {
      ...m,
      steps,
      file: entry.file,
    };
  });
});

// Read provider/model from config (allow env override for model)
const cfgPath = path.resolve(process.cwd(), 'testronaut-config.json');
let llmProvider = 'openai';
let llmModel = 'gpt-4o';

if (fs.existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg?.provider) llmProvider = String(cfg.provider);
    if (cfg?.model) llmModel = String(cfg.model);
  } catch (e) {
    console.warn('⚠️ Could not read testronaut-config.json:', e.message);
  }
}

// Env override takes precedence for the model (matches runtime behavior)
if (process.env.TESTRONAUT_MODEL?.trim()) {
  llmModel = process.env.TESTRONAUT_MODEL.trim();
}


const report = {
  runId,
  startTime: startTime.toISOString(),
  endTime: endTime.toISOString(),
  llm: {
    provider: llmProvider,
    model: llmModel,
  },
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

/**
 * Parse a fetch Response safely and return JSON or throw a rich error.
 * @param {Response} res
 * @param {string} urlLabel - human-friendly label for error messages
 * @returns {Promise<any>}
 * @throws when HTTP status is not ok or body is empty/invalid
 */
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

/**
 * Detect the local package manager based on lockfiles.
 * @param {string} [cwd=process.cwd()]
 * @returns {'pnpm'|'yarn'|'bun'|'npm'}
 */
function pkgManagerForCwd(cwd = process.cwd()) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb')) return 'bun';
  return 'npm';
}

async function hasAny(modNames) {
  try {
    for (const m of modNames) {
      // Use createRequire so ESM can resolve CJS packages relative to the project
      const { createRequire } = await import('module');
      const req = createRequire(path.join(process.cwd(), 'noop.js'));
      req.resolve(m);
      return m;
    }
  } catch {}
  return null;
}

async function installDev(pkgMgr, pkg) {
  const cmd =
    pkgMgr === 'pnpm' ? `pnpm add -D ${pkg}` :
    pkgMgr === 'yarn' ? `yarn add -D ${pkg}` :
    pkgMgr === 'bun'  ? `bun add -d ${pkg}` :
                        `npm i -D ${pkg}`;
  await exec(cmd, { stdio: 'inherit' });
}

export async function ensurePlaywrightInstalled() {
  // 1) Is playwright already present?
  const present = await hasAny(['@playwright/test', 'playwright']);
  if (!present) {
    console.log('📦 @playwright/test not found. Installing…');
    const pm = pkgManagerForCwd();
    try {
      await installDev(pm, '@playwright/test');
      console.log('✅ @playwright/test installed.');
    } catch (err) {
      console.error('❌ Failed to install @playwright/test:', err?.message || err);
      console.error('   Try installing manually and re-run init.');
      return false;
    }
  }

  // 2) Install browsers (skip in CI if desired)
  if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
    console.log('⏭️  Skipping browser download (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).');
    return true;
  }

  console.log('🧭 Ensuring Playwright browsers are installed…');

  // Use npx with explicit package + -y to avoid prompts and PATH issues
  // (works even if the local bin is not on PATH yet)
  const installCmd = `npx -y playwright@latest install --with-deps`;

  try {
    await exec(installCmd, { stdio: 'inherit', env: process.env });
    console.log('✅ Playwright browsers installed.');
    return true;
  } catch (err) {
    // Some shells can’t find `playwright` even via npx. Fall back to package-runner:
    // npm 7+: `npm exec`, yarn: `yarn playwright`, pnpm: `pnpm exec`
    const pm = pkgManagerForCwd();
    const fallback =
      pm === 'pnpm' ? `pnpm exec playwright install --with-deps` :
      pm === 'yarn' ? `yarn playwright install --with-deps` :
      pm === 'bun'  ? `bunx playwright install --with-deps` :
                      `npm exec --yes playwright@latest install --with-deps`;

    console.log('⚠️  npx fallback:', err?.message || err);
    console.log(`↩️  Retrying with: ${fallback}`);
    try {
      await exec(fallback, { stdio: 'inherit', env: process.env });
      console.log('✅ Playwright browsers installed on retry.');
      return true;
    } catch (err2) {
      console.error('❌ Failed to install Playwright browsers:', err2?.message || err2);
      console.error('   Manual fix:');
      console.error('     1) npm i -D @playwright/test');
      console.error('     2) npx -y playwright@latest install --with-deps');
      return false;
    }
  }
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
        'Content-Type': 'application/x-www-form-urlencoded',
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

/**
 * Guess a reasonable MIME type for static serving.
 * @param {string} p - file path
 * @returns {string}
 */
function guessMimeType(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * Path-join a request path to a root directory with traversal protection.
 * @param {string} root - filesystem directory
 * @param {string} relUrlPath - URL path from incoming request
 * @returns {string|null} resolved path or null on attempted escape
 */
function safeJoin(root, relUrlPath) {
  // Prevent path traversal and keep within root
  const decoded = decodeURIComponent(relUrlPath);
  const clean = decoded.replace(/^\/+/, ''); // strip leading slash
  const resolved = path.resolve(root, clean);
  if (!resolved.startsWith(path.resolve(root))) {
    return null; // attempted escape
  }
  return resolved;
}

/**
 * Best-effort cross-platform URL opener.
 * @param {string} targetUrl
 * @returns {Promise<void>}
 */
async function openInBrowser(targetUrl) {
  const platform = process.platform;
  const quoted = `"${targetUrl}"`;
  if (platform === 'darwin') return exec(`open ${quoted}`);
  if (platform === 'win32') return exec(`start "" ${quoted}`);
  return exec(`xdg-open ${quoted}`).catch(() => {}); // best-effort on Linux
}

/**
 * Find the latest run HTML (and its matching JSON, if present).
 * Expects files like "run_<timestamp>.html" in the report directory.
 * @param {string} reportDir
 * @returns {{htmlFile:string, jsonFile:string|null}|null}
 */
function findLatestReportPair(reportDir) {
  if (!fs.existsSync(reportDir)) return null;
  const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.html'));
  if (!files.length) return null;

  // Expecting run_<timestamp>.html — sort by numeric timestamp descending
  files.sort((a, b) => {
    const ta = parseInt(a.split('_')[1]) || 0;
    const tb = parseInt(b.split('_')[1]) || 0;
    return tb - ta;
  });

  const latestHtml = files[0];
  const latestBase = path.basename(latestHtml, '.html');
  const jsonCandidate = `${latestBase}.json`;

  return {
    htmlFile: latestHtml,
    jsonFile: fs.existsSync(path.join(reportDir, jsonCandidate)) ? jsonCandidate : null,
  };
}

async function serveLatestReport() {
  const reportDir = path.resolve(process.cwd(), 'missions/mission_reports');

  const latest = findLatestReportPair(reportDir);
  if (!latest) {
    console.error('❌ No HTML reports found in missions/mission_reports.');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    try {
      // Default route -> redirect to latest report
      const parsed = url.parse(req.url || '/');
      let pathname = parsed.pathname || '/';

      if (pathname === '/' || pathname === '') {
        res.statusCode = 302;
        res.setHeader('Location', `/${latest.htmlFile}`);
        res.end();
        return;
      }

      const targetPath = safeJoin(reportDir, pathname);
      if (!targetPath) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }

      // If the path is a directory, try index.html (not expected, but harmless)
      let toServe = targetPath;
      if (fs.existsSync(toServe) && fs.statSync(toServe).isDirectory()) {
        toServe = path.join(toServe, 'index.html');
      }

      if (!fs.existsSync(toServe) || !fs.statSync(toServe).isFile()) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', guessMimeType(toServe));
      fs.createReadStream(toServe).pipe(res);
    } catch (err) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  // Listen on a random free port
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  // Move signal handling to after server is listening
  const shutdown = () => {
    console.log('\n🛑 Shutting down…');
    try {
      server.close(); // best-effort; don’t wait for it
    } catch (_) {
      // ignore
    }
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const reportUrl = `${baseUrl}/${latest.htmlFile}`;

  console.log(`📄 Serving reports from: ${path.relative(process.cwd(), reportDir)}`);
  console.log(`🔗 Opening latest: ${latest.htmlFile}`);
  console.log(`🌐 ${reportUrl}`);

  // Best-effort auto-open
  await openInBrowser(reportUrl).catch(() => {});
}

try {
  if (!process.env.TN_KEEP_TMP && fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    console.log('🧹 Cleaned up temporary files.');
  } else {
    console.log('⚠️ Skipped tmp cleanup (TN_KEEP_TMP set).');
  }
} catch (err) {
  console.warn(`⚠️ Could not remove tmp folder: ${err.message}`);
}
