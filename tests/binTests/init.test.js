// tests/cliTests/init.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────
// Hoisted queue for the `prompts` mock
// ─────────────────────────────────────────────
const { shared } = vi.hoisted(() => ({
  shared: {
    answers: [], // each element should be the resolved object for one prompts() call
    calls: 0,
  },
}));

// Mock `prompts` to return queued answers
vi.mock('prompts', () => ({
  default: async () => {
    shared.calls += 1;
    if (!shared.answers.length) {
      throw new Error('Test prompts queue empty. Push expected answers to shared.answers.');
    }
    return shared.answers.shift();
  },
}));

// Important: import SUT after mocks
import { initializeTestronautProject } from '../../bin/init';

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-init-'));
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

const originalCwd = process.cwd();
const ORIGINAL_ENV = { ...process.env };

describe('initializeTestronautProject', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    shared.answers = [];
    shared.calls = 0;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.chdir(originalCwd);
  });

  it('scaffolds a new OpenAI project: config, .env, folders, welcome mission', async () => {
    const temp = makeTempProject();
    process.chdir(temp);

    // Queue answers for two prompts:
    // 1) provider
    // 2) openai model
    shared.answers.push({ llmProvider: 'openai' });
    shared.answers.push({ openaiModel: 'gpt-4o' });

    await initializeTestronautProject();

    // Config
    const configPath = path.join(temp, 'testronaut-config.json');
    expect(fileExists(configPath)).toBe(true);
    const cfg = readJson(configPath);
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o');
    expect(cfg.initialized).toBe(true);
    expect(cfg.outputDir).toBe('missions/mission_reports');
    expect(typeof cfg.maxTurns).toBe('number');

    // .env
    const envPath = path.join(temp, '.env');
    expect(fileExists(envPath)).toBe(true);
    const envTxt = fs.readFileSync(envPath, 'utf8');
    expect(envTxt).toMatch(/OPENAI_API_KEY=sk-/);

    // Folders
    expect(dirExists(path.join(temp, 'missions'))).toBe(true);
    expect(dirExists(path.join(temp, 'missions', 'mission_reports'))).toBe(true);

    // Welcome mission (name depends on your implementation; we check presence in missions/)
    const files = fs.readdirSync(path.join(temp, 'missions'));
    expect(files.some(f => /welcome/i.test(f))).toBe(true);

    // Exactly two prompts were asked
    expect(shared.calls).toBe(2);
  });

  it('scaffolds a new Gemini project: config, .env, folders, welcome mission', async () => {
    const temp = makeTempProject();
    process.chdir(temp);

    shared.answers.push({ llmProvider: 'gemini' });
    shared.answers.push({ geminiModel: 'gemini-2.5-flash' });

    await initializeTestronautProject();

    const cfg = readJson(path.join(temp, 'testronaut-config.json'));
    expect(cfg.provider).toBe('gemini');
    expect(cfg.model).toBe('gemini-2.5-flash');

    const envTxt = fs.readFileSync(path.join(temp, '.env'), 'utf8');
    expect(envTxt).toMatch(/GEMINI_API_KEY=AIza/);

    expect(dirExists(path.join(temp, 'missions'))).toBe(true);
    expect(dirExists(path.join(temp, 'missions', 'mission_reports'))).toBe(true);

    const files = fs.readdirSync(path.join(temp, 'missions'));
    expect(files.some(f => /welcome/i.test(f))).toBe(true);

    expect(shared.calls).toBe(2);
  });

  it('is idempotent: when initialized, it skips prompts and does not overwrite .env', async () => {
    const temp = makeTempProject();
    process.chdir(temp);

    // Pre-create a config marked as initialized + a non-empty .env
    const configPath = path.join(temp, 'testronaut-config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        initialized: true,
        provider: 'openai',
        model: 'gpt-4o',
        outputDir: 'missions/mission_reports',
        projectName: 'demo',
        maxTurns: 20,
      }, null, 2),
      'utf8'
    );

    const envPath = path.join(temp, '.env');
    fs.writeFileSync(envPath, 'DO_NOT_TOUCH=1\n', 'utf8');

    // Also ensure folders are missing to verify folder creation still happens
    // (initialize should still ensure dirs even when skipping prompts)
    await initializeTestronautProject();

    // Prompts should not have been called
    expect(shared.calls).toBe(0);

    // .env untouched
    const envTxt = fs.readFileSync(envPath, 'utf8');
    expect(envTxt).toBe('DO_NOT_TOUCH=1\n');

    // Folders ensured
    expect(dirExists(path.join(temp, 'missions'))).toBe(true);
    expect(dirExists(path.join(temp, 'missions', 'mission_reports'))).toBe(true);

    // Config left as-is (no clobber)
    const cfg = readJson(configPath);
    expect(cfg.initialized).toBe(true);
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o');
  });

  it('preserves pre-existing fields and merges defaults without clobbering', async () => {
    const temp = makeTempProject();
    process.chdir(temp);

    // seed a partial config (not initialized yet)
    fs.writeFileSync(
      path.join(temp, 'testronaut-config.json'),
      JSON.stringify({ projectName: 'my-project' }, null, 2),
      'utf8'
    );

    shared.answers.push({ llmProvider: 'openai' });
    shared.answers.push({ openaiModel: 'gpt-4.1-mini' });

    await initializeTestronautProject();

    const cfg = readJson(path.join(temp, 'testronaut-config.json'));
    expect(cfg.projectName).toBe('my-project'); // preserved
    expect(cfg.outputDir).toBe('missions/mission_reports'); // default filled in
    expect(cfg.maxTurns).toBe(20); // default filled in
  });
});
