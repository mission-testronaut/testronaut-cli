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
 *   --provider <id> / --provider=<id>   → sets TESTRONAUT_PROVIDER env (wins over config file)
 *   --turns <n> / --turns=<n>           → sets TESTRONAUT_TURNS env (wins over config file)
 *   --init                               → scaffolds project + optional Playwright browsers
 *   --dev                                → use staging API base URL
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

// Missions often interpolate project .env values while their modules load.
// Load those values before discovery imports any user-authored mission code.
import 'dotenv/config';
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
import { resolveProviderModel } from '../llm/modelResolver.js';
import { exec as execCmd } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execCmd);
import url from 'url';
import { ensureBrowsers } from '../tools/playwrightSetup.js';
import { discoverMissionFiles } from '../core/missionDiscovery.js';
import { loadMissionModule } from '../core/missionLoader.js';
import { loadConfig } from '../core/config.js';
import { matchesTagFilter, normalizeTagMatch, normalizeTags } from '../core/tags.js';

// Keep PW browsers inside the project to avoid global cache skew
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const TMP_DIR = path.resolve('./missions/tmp');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')
).version;

const DEFAULT_API_BASE = 'http://api.testronaut.app';
const DEV_API_BASE = 'https://staging.api.testronaut.app';

let args = process.argv.slice(2);

const jsonOutput = args.includes('--json');
const quietOutput = args.includes('--quiet') || jsonOutput;
args = args.filter(arg => arg !== '--json' && arg !== '--quiet');
const writeOutput = value => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
if (quietOutput) {
  console.log = () => {};
  console.warn = () => {};
}

const dryRun = args.includes('--dry-run');
args = args.filter(arg => arg !== '--dry-run');
const screenshotsEnabled = !args.includes('--no-screenshots');
args = args.filter(arg => arg !== '--no-screenshots');
const uploadScreenshots = !args.includes('--no-upload-screenshots');
args = args.filter(arg => arg !== '--no-upload-screenshots');
process.env.TESTRONAUT_SCREENSHOTS = screenshotsEnabled ? '1' : '0';

// Detect how the CLI was invoked so help text matches the actual command
function detectCliName(npmCommand = process.env.npm_command, argv1 = process.argv[1]) {
  // npx sets npm_command to 'exec'
  if (npmCommand === 'exec') return 'npx testronaut';
  // global install: argv[1] is the bin symlink named 'testronaut'
  if (path.basename(argv1 || '') === 'testronaut') return 'testronaut';
  return 'npx testronaut';
}

function isDirectInvocation(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(argv1) === path.resolve(modulePath);
  }
}

const cliName = detectCliName();

// Look for --dev / --developer / --developer-mode / --staging
const devFlagIndex = args.findIndex(a =>
  a === '--dev' ||
  a === '--developer' ||
  a === '--developer-mode' ||
  a === '--staging'
);
let apiBase = process.env.TESTRONAUT_API_BASE || DEFAULT_API_BASE;
if (devFlagIndex >= 0) {
  apiBase = DEV_API_BASE;
  console.log(`🧪 Developer mode: using ${apiBase}`);
  args.splice(devFlagIndex, 1);
}
process.env.TESTRONAUT_API_BASE_EFFECTIVE = apiBase;

function parseVercelBypassArgs(argsList) {
  const nextArgs = [...argsList];
  let secret;
  let invalid = false;
  const idx = nextArgs.findIndex(a =>
    a === '--vercel-bypass' ||
    a.startsWith('--vercel-bypass=') ||
    a === '--vercel_bypass' ||
    a.startsWith('--vercel_bypass=')
  );
  if (idx >= 0) {
    const rawArg = nextArgs[idx];
    const hasInline = rawArg.includes('=');
    if (hasInline) {
      secret = rawArg.split('=')[1];
    } else if (nextArgs[idx + 1]) {
      secret = nextArgs[idx + 1];
    }

    if (!secret) invalid = true;

    // Remove flag & value so they aren’t treated as filenames
    const consume = hasInline ? 1 : (secret ? 2 : 1);
    nextArgs.splice(idx, consume);
  }
  return { secret, args: nextArgs, invalid };
}

function parseProviderArgs(argsList) {
  const nextArgs = [...argsList];
  let provider;
  let invalid = false;
  const idx = nextArgs.findIndex(a => a === '--provider' || a.startsWith('--provider='));
  if (idx >= 0) {
    const rawArg = nextArgs[idx];
    const hasInline = rawArg.includes('=');
    const nextVal = !hasInline && nextArgs[idx + 1] && !nextArgs[idx + 1].startsWith('-') ? nextArgs[idx + 1] : undefined;
    if (hasInline) {
      provider = rawArg.split('=')[1];
    } else if (nextVal) {
      provider = nextVal;
    }

    if (provider) {
      provider = provider.trim();
    }

    const supportedProviders = new Set(['openai', 'gemini', 'anthropic', 'claude']);
    const isValid = (v) => !!v && supportedProviders.has(String(v).toLowerCase());
    if (!isValid(provider)) {
      invalid = true;
      provider = undefined;
    }

    // Remove flag & value so they aren’t treated as filenames
    const consume = hasInline ? 1 : (nextVal ? 2 : 1);
    nextArgs.splice(idx, consume);
  }
  return { provider, args: nextArgs, invalid };
}

function parseRunOptionsArgs(argsList) {
  const nextArgs = [...argsList];
  const options = {};
  let invalid = false;

  for (let idx = 0; idx < nextArgs.length;) {
    const rawArg = nextArgs[idx];
    const isInline =
      rawArg.startsWith('--options=') ||
      rawArg.startsWith('--option=') ||
      rawArg.startsWith('-o=');
    const isSeparate =
      rawArg === '--options' ||
      rawArg === '--option' ||
      rawArg === '-o';

    if (!isInline && !isSeparate) {
      idx += 1;
      continue;
    }

    const rawValue = isInline
      ? rawArg.slice(rawArg.indexOf('=') + 1)
      : nextArgs[idx + 1] && !nextArgs[idx + 1].startsWith('-')
        ? nextArgs[idx + 1]
        : '';

    if (!rawValue) {
      invalid = true;
      nextArgs.splice(idx, 1);
      continue;
    }

    for (const part of rawValue.split(',')) {
      const [keyRaw, ...valueParts] = part.split('=');
      const key = String(keyRaw || '').trim();
      const value = valueParts.join('=').trim();
      if (!key || !value) {
        invalid = true;
        continue;
      }
      options[key] = value;
    }

    nextArgs.splice(idx, isInline ? 1 : 2);
  }

  return { options, args: nextArgs, invalid };
}


const vercelBypassResult = parseVercelBypassArgs(args);
if (vercelBypassResult.invalid) {
  console.warn('⚠️ Invalid --vercel-bypass value. Provide a non-empty secret.');
}
args = vercelBypassResult.args;
const vercelBypassOverride = vercelBypassResult.secret;

const vercelBypassSecret =
  vercelBypassOverride ||
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET ||
  process.env.TESTRONAUT_VERCEL_BYPASS;
function createVercelBypassHeader(secret) {
  return secret ? { 'x-vercel-protection-bypass': secret } : {};
}
const vercelBypassHeader = createVercelBypassHeader(vercelBypassSecret);

function buildApiHeaders(extra = {}) {
  return { ...extra, ...vercelBypassHeader };
}

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
  parseVercelBypassArgs,
  createVercelBypassHeader,
  parseProviderArgs,
  parseRunOptionsArgs,
  detectCliName,
  isDirectInvocation,
  resolveMissionPath,
  collectReportScreenshotNames,
  collectReportScreenshotPaths,
  resolveReportDir,
  closestMissionMatch,
  resolveReportFile,
  buildEffectiveConfig,
};

function resolveReportDir(config = {}, cwd = process.cwd()) {
  return path.resolve(cwd, config.outputDir || 'missions/mission_reports');
}

function resolveReportFile(requested, reportDir, cwd = process.cwd()) {
  if (!requested) return null;
  const names = path.extname(requested) ? [requested] : [requested, `${requested}.json`];
  for (const name of names) {
    const direct = path.resolve(cwd, name);
    if (fs.existsSync(direct)) return direct;
    const inReportDir = path.resolve(reportDir, name);
    if (fs.existsSync(inReportDir)) return inReportDir;
  }
  return path.resolve(reportDir, names.at(-1));
}

function buildEffectiveConfig(config = {}, cwd = process.cwd()) {
  const resolved = resolveProviderModel({ cwd });
  const source = key => process.env[key] ? 'environment' : undefined;
  return {
    configFile: path.resolve(cwd, 'testronaut-config.json'),
    provider: { value: resolved.provider, source: source('TESTRONAUT_PROVIDER') || (config.provider ? 'config' : 'default') },
    model: { value: resolved.model, source: source('TESTRONAUT_MODEL') || (config.model ? 'config' : 'default') },
    outputDir: { value: resolveReportDir(config, cwd), source: config.outputDir ? 'config' : 'default' },
    maxTurns: { value: Number(process.env.TESTRONAUT_TURNS || config.maxTurns || 20), source: source('TESTRONAUT_TURNS') || (config.maxTurns != null ? 'config' : 'default') },
    tags: config.tags || [],
    tagMatch: config.tagMatch || 'any',
    addTags: normalizeTags([...(config.addTags || []), ...cliAddTags]),
    screenshots: screenshotsEnabled,
    authenticated: Boolean(config.sessionToken),
  };
}

function closestMissionMatch(requested, candidates = []) {
  const target = path.basename(requested).toLowerCase();
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = saved;
      }
    }
    return row[b.length];
  };
  return candidates
    .map(file => ({ file, distance: distance(target, path.basename(file).toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file))[0]?.file || null;
}

function resolveMissionPath(filePath, { cwd = process.cwd(), missionsRoot } = {}) {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);

  const directPath = path.resolve(cwd, filePath);
  const hasPathSegments = path.dirname(filePath) !== '.';
  if (hasPathSegments || fs.existsSync(directPath)) return directPath;

  return path.resolve(missionsRoot || path.join(cwd, 'missions'), filePath);
}

function collectReportScreenshotNames(report) {
  return collectReportScreenshotPaths(report).map(file => path.basename(file));
}

function collectReportScreenshotPaths(report) {
  const names = [];
  const seen = new Set();
  for (const mission of Array.isArray(report?.missions) ? report.missions : []) {
    for (const step of Array.isArray(mission?.steps) ? mission.steps : []) {
      if (typeof step?.screenshotPath !== 'string') continue;
      const name = step.screenshotPath.trim().replace(/^\.\//, '').replaceAll('\\', '/');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function parseTagArgs(argsList) {
  const nextArgs = [];
  const tagValues = [];
  const addTagValues = [];
  let tagMatchValue;
  let tagsPresent = false;
  let addTagsPresent = false;
  let tagMatchPresent = false;
  let tagsMissingValue = false;
  let addTagsMissingValue = false;

  const matchFlag = (raw, names) => names.some(name => raw === name || raw.startsWith(`${name}=`));
  const readValue = (raw, index) => {
    if (raw.includes('=')) return { value: raw.slice(raw.indexOf('=') + 1), consumed: 1 };
    const candidate = argsList[index + 1];
    return candidate && !candidate.startsWith('-')
      ? { value: candidate, consumed: 2 }
      : { value: undefined, consumed: 1 };
  };

  for (let index = 0; index < argsList.length;) {
    const raw = argsList[index];
    if (matchFlag(raw, ['--tag', '--tags'])) {
      const { value, consumed } = readValue(raw, index);
      tagsPresent = true;
      if (value !== undefined) tagValues.push(value);
      else tagsMissingValue = true;
      index += consumed;
    } else if (matchFlag(raw, ['--add-tag', '--add-tags', '--add_tag', '--add_tags'])) {
      const { value, consumed } = readValue(raw, index);
      addTagsPresent = true;
      if (value !== undefined) addTagValues.push(value);
      else addTagsMissingValue = true;
      index += consumed;
    } else if (matchFlag(raw, ['--tag-match', '--tag_match'])) {
      const { value, consumed } = readValue(raw, index);
      tagMatchPresent = true;
      tagMatchValue = value;
      index += consumed;
    } else {
      nextArgs.push(raw);
      index += 1;
    }
  }

  return {
    args: nextArgs,
    tags: { present: tagsPresent, value: tagValues.length ? tagValues.join(',') : undefined, missingValue: tagsMissingValue },
    addTags: { present: addTagsPresent, value: addTagValues.length ? addTagValues.join(',') : undefined, missingValue: addTagsMissingValue },
    tagMatch: { present: tagMatchPresent, value: tagMatchValue },
    hasUnquotedCommaSpace: [...tagValues, ...addTagValues].some(value => value.trimEnd().endsWith(',')),
  };
}
__test__.parseTagArgs = parseTagArgs;

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

// Look for --provider=<id> or --provider <id>
const providerResult = parseProviderArgs(args);
if (providerResult.invalid) {
  console.warn('⚠️ Invalid --provider value. Provide a non-empty provider id.');
}
args = providerResult.args;
const providerOverride = providerResult.provider;
if (providerOverride) {
  process.env.TESTRONAUT_PROVIDER = providerOverride.trim();
  console.log(`🧩 Provider override: ${process.env.TESTRONAUT_PROVIDER}`);
}

const runOptionsResult = parseRunOptionsArgs(args);
if (runOptionsResult.invalid) {
  console.warn('⚠️ Invalid --options value. Use key=value pairs, for example: -o mfa=github-test-mfa');
}
args = runOptionsResult.args;
const cliMfaName =
  runOptionsResult.options.mfa ||
  runOptionsResult.options.mfaName ||
  runOptionsResult.options['mfa-name'];
if (cliMfaName) {
  process.env.TESTRONAUT_MFA_NAME = String(cliMfaName).trim();
  console.log(`🔐 MFA nickname override: ${process.env.TESTRONAUT_MFA_NAME}`);
}

const tagArgs = parseTagArgs(args);
args = tagArgs.args;
let cliTags;
let cliAddTags = [];
let cliTagMatch;
try {
  if (tagArgs.hasUnquotedCommaSpace) {
    throw new Error('A tag list ends with a comma. Quote comma-and-space lists (for example --tags "authentication, smoke") or repeat --tag for each tag.');
  }
  if (tagArgs.tags.missingValue || (tagArgs.tags.present && !tagArgs.tags.value)) throw new Error('--tag/--tags requires a tag value.');
  if (tagArgs.addTags.missingValue || (tagArgs.addTags.present && !tagArgs.addTags.value)) throw new Error('--add-tag/--add-tags requires a tag value.');
  if (tagArgs.tagMatch.present && !tagArgs.tagMatch.value) throw new Error('--tag-match requires "any" or "all".');
  if (tagArgs.tags.present) cliTags = normalizeTags(tagArgs.tags.value, { allowUntagged: true });
  if (tagArgs.addTags.present) cliAddTags = normalizeTags(tagArgs.addTags.value);
  if (tagArgs.tagMatch.present) cliTagMatch = normalizeTagMatch(tagArgs.tagMatch.value);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

// Look for --debug / --debug=<bool> / --no-debug
// Normalize CLI boolean strings into true/false/null for optional flags.
const parseBool = (v) => {
  const lower = String(v ?? '').trim().toLowerCase();
  if (!lower) return null;
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return null;
};
__test__.parseBool = parseBool;

let debugOverride;
let debugConsumesNext = false;
const debugFlagIndex = args.findIndex(a =>
  a === '--debug' ||
  a.startsWith('--debug=') ||
  a === '--no-debug'
);
if (debugFlagIndex >= 0) {
  const rawArg = args[debugFlagIndex];
  if (rawArg.includes('=')) {
    debugOverride = parseBool(rawArg.split('=')[1]);
  } else if (rawArg === '--no-debug') {
    debugOverride = false;
  } else if (args[debugFlagIndex + 1] && !args[debugFlagIndex + 1].startsWith('-')) {
    debugOverride = parseBool(args[debugFlagIndex + 1]);
    debugConsumesNext = true;
  } else {
    debugOverride = true; // bare --debug enables it
  }

  if (debugOverride !== null) {
    process.env.TESTRONAUT_DEBUG = debugOverride ? '1' : '0';
    console.log(`🛠️ Debug mode ${debugOverride ? 'enabled' : 'disabled'} (TESTRONAUT_DEBUG=${process.env.TESTRONAUT_DEBUG})`);
  } else {
    console.warn('⚠️ Invalid --debug value. Use true/false, 1/0, yes/no.');
  }

  const consume = 1 + (debugConsumesNext && debugOverride !== null ? 1 : 0);
  args.splice(debugFlagIndex, consume);
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

// Look for --human-input / --no-human-input / --disable-human-input
let humanInputOverride;
let humanInputConsumesNext = false;
const humanInputFlagIndex = args.findIndex(a =>
  a === '--human-input' ||
  a.startsWith('--human-input=') ||
  a === '--human_input' ||
  a.startsWith('--human_input=') ||
  a === '--no-human-input' ||
  a === '--disable-human-input'
);
if (humanInputFlagIndex >= 0) {
  const rawArg = args[humanInputFlagIndex];
  if (rawArg.includes('=')) {
    humanInputOverride = parseBool(rawArg.split('=')[1]);
  } else if (rawArg === '--no-human-input' || rawArg === '--disable-human-input') {
    humanInputOverride = false;
  } else if (args[humanInputFlagIndex + 1] && !args[humanInputFlagIndex + 1].startsWith('-')) {
    humanInputOverride = parseBool(args[humanInputFlagIndex + 1]);
    humanInputConsumesNext = true;
  } else {
    humanInputOverride = true;
  }

  if (humanInputOverride !== null) {
    process.env.TESTRONAUT_HUMAN_INPUT = humanInputOverride ? '1' : '0';
    console.log(`👤 Human input tool ${humanInputOverride ? 'enabled' : 'disabled'} (TESTRONAUT_HUMAN_INPUT=${process.env.TESTRONAUT_HUMAN_INPUT})`);
  } else {
    console.warn('⚠️ Invalid --human-input value. Use true/false, 1/0, yes/no.');
  }

  const consume = 1 + (humanInputConsumesNext && humanInputOverride !== null ? 1 : 0);
  args.splice(humanInputFlagIndex, consume);
}

// Look for --human-input-timeout / --human_input_timeout in seconds
let humanInputTimeoutOverride;
const humanInputTimeoutFlagIndex = args.findIndex(a =>
  a === '--human-input-timeout' ||
  a.startsWith('--human-input-timeout=') ||
  a === '--human_input_timeout' ||
  a.startsWith('--human_input_timeout=')
);
if (humanInputTimeoutFlagIndex >= 0) {
  const rawArg = args[humanInputTimeoutFlagIndex];
  if (rawArg.includes('=')) {
    humanInputTimeoutOverride = rawArg.split('=')[1];
  } else if (args[humanInputTimeoutFlagIndex + 1]) {
    humanInputTimeoutOverride = args[humanInputTimeoutFlagIndex + 1];
  }

  if (humanInputTimeoutOverride) {
    const n = Number(humanInputTimeoutOverride.trim());
    if (Number.isFinite(n) && n > 0) {
      process.env.TESTRONAUT_HUMAN_INPUT_TIMEOUT_SECONDS = String(n);
      console.log(`⏱️ Human input timeout override: ${process.env.TESTRONAUT_HUMAN_INPUT_TIMEOUT_SECONDS}s`);
    } else {
      console.warn(`⚠️ Invalid --human-input-timeout value "${humanInputTimeoutOverride}". Ignoring.`);
    }
  }

  args.splice(humanInputTimeoutFlagIndex, humanInputTimeoutOverride ? 2 : 1);
}

const allResults = [];
const runId = `run_${Date.now()}`;
const startTime = new Date();

const HELP_TEXT = `
🧑‍🚀 testronaut - Autonomous Agent Mission Runner

Usage:
  ${cliName}                 Run all missions in the ./missions directory
  ${cliName} <file>         Run a .mission.js or .mission.ts file by name or path
  ${cliName} login          Log in and store session token
  ${cliName} list           List discovered missions and tags without running them
  ${cliName} config         Show effective configuration and value sources
  ${cliName} upload [file]  Upload the latest report or a selected report file/run ID
  ${cliName} serve        Serve & open the most recent HTML report (read-only)
  ${cliName} view         Alias of 'serve'

Options:
  --init                    Scaffold project folders and a welcome mission
  --turns=<n>               Override max turns for this run (e.g., --turns=30)
  --debug[=<bool>]          Enable verbose debug logs (or set TESTRONAUT_DEBUG=1)
  --provider=<id>           Override LLM provider (openai, gemini, or anthropic)
  -o, --options key=value   Set run options, such as mfa=github-test-mfa
  --dev                     Use the staging API base URL
  --vercel-bypass=<secret>  Send Vercel protection bypass header for protected deployments
  --human-input[=<bool>]    Allow the agent to pause for short verification codes (default: true)
  --no-human-input          Disable human-in-the-loop verification prompts for automated runs
  --human-input-timeout=<s> Override human input wait timeout in seconds (default: 60)
  --help                    Show this help message
  --dry-run                 Show the resolved mission plan without launching a browser
  --no-screenshots          Remove the screenshot tool for this run
  --no-upload-screenshots   Upload report JSON without its screenshots
  --json                    Emit machine-readable command/run output
  --quiet                   Suppress informational logs
  --retry_limit=<n>         Override agent turn retry limits (minimum 1, maximum 10)
  --tag=<tag>               Run missions matching a tag; repeat for multiple tags
  --tags=<tag,...>          Compact comma-list form (OR/any by default)
  --tag-match=<any|all>     Match any or all requested tags
  --add-tag=<tag>           Add one report tag; repeat for multiple tags
  --add-tags=<tag,...>      Compact comma-list form for report tags

Examples:
  ${cliName}
  ${cliName} login
  ${cliName} list
  ${cliName} upload
  ${cliName} serve
  ${cliName} --init
  ${cliName} --tag authentication --tag smoke
  ${cliName} --add-tag staging --add-tag full-test-run
`;

async function main() {
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
       ${cliName}

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
if (args[0] === 'upload') {
  await uploadReport(args[1], { uploadScreenshots });
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
const tagConfig = await loadConfig(process.cwd());
const outputDir = resolveReportDir(tagConfig);
process.env.TESTRONAUT_OUTPUT_DIR = outputDir;
process.env.TESTRONAUT_RUN_ID = runId;

if (args.length === 1 && args[0] === 'config') {
  writeOutput(buildEffectiveConfig(tagConfig));
  return;
}

if (args.length === 1 && args[0] === 'list') {
  if (!discoveredMissions.length) {
    writeOutput(jsonOutput ? { missions: [], root: missionsRoot } : `No missions found in ${path.relative(process.cwd(), missionsRoot) || '.'}.`);
    return;
  }
  const listedMissions = [];
  if (!jsonOutput) console.log(`Missions in ${path.relative(process.cwd(), missionsRoot) || '.'}:`);
  for (const file of discoveredMissions) {
    try {
      const mission = await loadMissionModule(path.resolve(missionsRoot, file));
      const tags = normalizeTags(mission.tags);
      listedMissions.push({ file, tags });
      if (!jsonOutput) console.log(`  ${file}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
    } catch (error) {
      console.log(`  ${file}  [could not load: ${error.message}]`);
      process.exitCode = 1;
    }
  }
  if (jsonOutput) writeOutput({ root: missionsRoot, missions: listedMissions });
  return;
}

const explicitFiles = args.length > 0;
let requestedTags = [];
let tagMatch = 'any';
try {
  requestedTags = explicitFiles ? [] : (cliTags ?? normalizeTags(tagConfig?.tags, { allowUntagged: true }));
  tagMatch = explicitFiles ? 'any' : normalizeTagMatch(cliTagMatch ?? tagConfig?.tagMatch);
  process.env.TESTRONAUT_ADD_TAGS = normalizeTags([
    ...normalizeTags(tagConfig?.addTags),
    ...cliAddTags,
  ]).join(',');
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

if (!explicitFiles && !fs.existsSync(missionsRoot)) {
  console.error(`❌ Missions directory not found: ${path.relative(process.cwd(), missionsRoot)}`);
  process.exit(1);
}

if (dryRun) {
  const candidates = explicitFiles ? args : discoveredMissions;
  const missions = [];
  let invalid = false;
  for (const file of candidates) {
    const modulePath = resolveMissionPath(file, { cwd: process.cwd(), missionsRoot });
    if (!fs.existsSync(modulePath)) {
      missions.push({ file, status: 'missing', suggestion: closestMissionMatch(file, discoveredMissions) });
      invalid = true;
      continue;
    }
    try {
      const mission = await loadMissionModule(modulePath);
      const tags = normalizeTags(mission.tags);
      const selected = explicitFiles || matchesTagFilter(tags, requestedTags, tagMatch);
      missions.push({ file: path.relative(process.cwd(), modulePath), tags, selected, valid: typeof mission.executeMission === 'function' });
      if (typeof mission.executeMission !== 'function') invalid = true;
    } catch (error) {
      missions.push({ file, status: 'load-error', error: error.message });
      invalid = true;
    }
  }
  writeOutput({ dryRun: true, outputDir, provider: resolveProviderModel({ cwd: process.cwd() }), screenshots: screenshotsEnabled, missions });
  if (invalid) process.exitCode = 1;
  return;
}

const runFile = async (filePath) => {
  const modulePath = resolveMissionPath(filePath, { cwd: process.cwd(), missionsRoot });
  try {
    if (!fs.existsSync(modulePath)) {
      const suggestion = closestMissionMatch(filePath, discoveredMissions);
      console.error(`❌ Mission file not found: ${filePath}`);
      if (suggestion) console.error(`   Did you mean "${suggestion}"?`);
      return false;
    }
    const missionsModule = await loadMissionModule(modulePath);

    if (!explicitFiles) {
      const moduleTags = normalizeTags(missionsModule.tags);
      if (!matchesTagFilter(moduleTags, requestedTags, tagMatch)) return null;
    }

    if (typeof missionsModule.executeMission === 'function') {
      const result = await missionsModule.executeMission();
      if (result == null) {
        console.error(`❌ Mission did not return a result: ${filePath}`);
        return false;
      }
      allResults.push({
        file: path.relative(process.cwd(), modulePath) || path.basename(modulePath),
        result
      });
      const missionResults = Array.isArray(result) ? result : [result];
      return !missionResults.some(item => item?.status === 'failed');
    }
    console.error(`❌ Mission does not export executeMission(): ${filePath}`);
  } catch (err) {
    console.error(`❌ Error running mission: ${filePath}`);
    console.error(`   ${err?.message || err}`);
  }
  return false;
};

if (args.length > 0) {
  // Run specific file(s)
  for (const file of args) {
    if (!await runFile(file)) process.exitCode = 1;
  }
} else {
  // Run missions discovered from config (or default behavior)
  for (const file of discoveredMissions) {
    if (await runFile(file) === false) process.exitCode = 1;
  }
}

if (!explicitFiles && discoveredMissions.length === 0) {
  console.error(`❌ No mission files found in ${path.relative(process.cwd(), missionsRoot) || '.'}.`);
  process.exit(1);
}

if (!explicitFiles && requestedTags.length && allResults.length === 0) {
  console.error(`❌ No missions matched ${tagMatch === 'all' ? 'all' : 'any'} of: ${requestedTags.join(', ')}`);
  process.exit(1);
}

if (allResults.length === 0) return;

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

// Read provider/model from config (allow env override)
const { provider: llmProvider, model: llmModel } = resolveProviderModel({ cwd: process.cwd() });


const report = {
  runId,
  cli: { version: CLI_VERSION },
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
report.tags = normalizeTags(flatMissions.flatMap(m =>
  m.submissionType === 'mission' ? (m.tags ?? []) : []
));

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, `${runId}.json`), JSON.stringify(report, null, 2));
generateHtmlReport(report, path.join(outputDir, `${runId}.html`));
if (jsonOutput) writeOutput(report);

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
}

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
      headers: buildApiHeaders({
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      body: formData.toString(),
    });

    const data = await parseJsonSafe(response, 'login');

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
async function uploadReport(requestedReport, { uploadScreenshots: shouldUploadScreenshots = true } = {}) {
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
  const reportDir = resolveReportDir(config);
  if (!requestedReport && !fs.existsSync(reportDir)) {
    console.error(`❌ Report directory not found: ${path.relative(process.cwd(), reportDir) || reportDir}`);
    process.exit(1);
  }
  const files = fs.existsSync(reportDir) ? fs.readdirSync(reportDir).filter(f => f.endsWith('.json')) : [];
  if (!requestedReport && files.length === 0) {
    console.error('❌ No report files found.');
    process.exit(1);
  }
  files.sort((a, b) => parseInt(b.split('_')[1]) - parseInt(a.split('_')[1]));
  const selectedReportPath = requestedReport
    ? resolveReportFile(requestedReport, reportDir)
    : path.join(reportDir, files[0]);
  if (!fs.existsSync(selectedReportPath)) {
    console.error(`❌ Report file not found: ${requestedReport}`);
    process.exit(1);
  }
  const latestReportPath = selectedReportPath;
  const latestReportFile = path.basename(selectedReportPath);
  const reportJson = fs.readFileSync(latestReportPath, 'utf8');
  const report = JSON.parse(reportJson);
  const selectedReportDir = path.dirname(selectedReportPath);

  // 2) Upload report FIRST and capture its ID
  console.log(`🛰️  Uploading report: ${latestReportFile}`);
  let savedReportId; // <-- make sure this is defined before screenshot code
  try {
    const res = await fetch(`${apiBase}/api/user/cli/${sessionToken}`, {
      method: 'POST',
      headers: buildApiHeaders({ 'Content-Type': 'application/json' }),
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

  if (!shouldUploadScreenshots) {
    console.log('ℹ️  Screenshot upload disabled. Report JSON upload complete.');
    if (jsonOutput) writeOutput({ ok: true, reportId: savedReportId, report: latestReportFile, screenshotsUploaded: 0 });
    return;
  }

  // 3) Now find the fixed 'screenshots' folder next to JSON
  const screenshotsDir = path.join(selectedReportDir, 'screenshots');
  if (!fs.existsSync(screenshotsDir) || !fs.statSync(screenshotsDir).isDirectory()) {
    console.log('ℹ️  No screenshots directory found. Done.');
    if (jsonOutput) writeOutput({ ok: true, reportId: savedReportId, report: latestReportFile, screenshotsUploaded: 0 });
    return;
  }

  // 4) Collect and sort images by timestamp in filename
  const parseScreenshotTimestamp = (name) => {
    const m = name.match(/^screenshot_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/i);
    if (!m) return Number.MAX_SAFE_INTEGER;
    const [_, Y, M, D, h, mnt, s, ms] = m;
    return Date.UTC(+Y, +M - 1, +D, +h, +mnt, +s, +ms);
  };

  const imageFiles = collectReportScreenshotPaths(report)
    .map(relativePath => ({
      relativePath,
      filePath: path.resolve(selectedReportDir, relativePath),
    }))
    .filter(({ filePath }) =>
      filePath.startsWith(`${path.resolve(screenshotsDir)}${path.sep}`) &&
      fs.existsSync(filePath) &&
      fs.statSync(filePath).isFile() &&
      /\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)
    )
    .sort((a, b) => parseScreenshotTimestamp(path.basename(a.filePath)) - parseScreenshotTimestamp(path.basename(b.filePath)));

  if (!imageFiles.length) {
    console.log('ℹ️  This report does not reference any available screenshots. Done.');
    if (jsonOutput) writeOutput({ ok: true, reportId: savedReportId, report: latestReportFile, screenshotsUploaded: 0 });
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
    const { filePath, relativePath: f } = imageFiles[i];
    const stepIndex = i;

    if (!quietOutput) process.stdout.write(`   ➜ ${f} (step ${stepIndex}) … `);
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
        headers: buildApiHeaders({ 'Content-Type': 'application/json' }),
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
        headers: buildApiHeaders({ 'Content-Type': 'application/json' }),
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

      if (!quietOutput) process.stdout.write('ok\n');
    } catch (err) {
      if (!quietOutput) process.stdout.write('FAIL\n');
      failures.push({ file: f, error: err.message || String(err) });
    }
  }

  if (failures.length) {
    console.log('\n⚠️  Some screenshots failed to upload:');
    for (const f of failures) console.log(`   - ${f.file}: ${f.error}`);
    process.exitCode = 1;
    if (jsonOutput) writeOutput({ ok: false, reportId: savedReportId, report: latestReportFile, screenshotsUploaded: imageFiles.length - failures.length, failures });
  } else {
    console.log('✅ All screenshots uploaded.');
    if (jsonOutput) writeOutput({ ok: true, reportId: savedReportId, report: latestReportFile, screenshotsUploaded: imageFiles.length });
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
  const config = await loadConfig(process.cwd());
  const reportDir = resolveReportDir(config);

  const latest = findLatestReportPair(reportDir);
  if (!latest) {
    console.error(`❌ No HTML reports found in ${path.relative(process.cwd(), reportDir) || reportDir}.`);
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

if (isDirectInvocation()) {
  await main();
}
