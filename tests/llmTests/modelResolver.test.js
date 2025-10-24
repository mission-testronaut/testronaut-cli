// tests/llmTests/modelResolver.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveProviderModel } from '../../llm/modelResolver.js';

const ORIGINAL_ENV = { ...process.env };
const originalCwd = process.cwd();

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-'));
}
function writeConfig(dir, obj) {
  fs.writeFileSync(path.join(dir, 'testronaut-config.json'), JSON.stringify(obj, null, 2), 'utf8');
}
function clearResolverEnv() {
  delete process.env.TESTRONAUT_PROVIDER;
  delete process.env.TESTRONAUT_MODEL;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  clearResolverEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.chdir(originalCwd);
});

describe('resolveProviderModel', () => {
  it('returns env provider/model when both set', () => {
    process.env.TESTRONAUT_PROVIDER = 'gemini';
    process.env.TESTRONAUT_MODEL = 'gemini-2.5-flash';
    const res = resolveProviderModel();
    expect(res).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('reads provider/model from config file when present', () => {
    const temp = makeTempProject();
    writeConfig(temp, { provider: 'openai', model: 'gpt-5' });

    const res = resolveProviderModel({ cwd: temp }); // 👈 pass cwd
    expect(res.provider).toBe('openai');
    expect(res.model).toBe('gpt-5');
  });

  it('applies env override for only one value (env model overrides config model)', () => {
    const temp = makeTempProject();
    writeConfig(temp, { provider: 'openai', model: 'gpt-4o' });
    process.env.TESTRONAUT_MODEL = 'gpt-5-mini';

    const res = resolveProviderModel({ cwd: temp });
    expect(res.provider).toBe('openai');
    expect(res.model).toBe('gpt-5-mini');
  });

  it('handles legacy config with model="openai"', () => {
    const temp = makeTempProject();
    writeConfig(temp, { model: 'openai' });

    const res = resolveProviderModel({ cwd: temp });
    expect(res).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('returns defaults when config missing', () => {
    const temp = makeTempProject();
    const res = resolveProviderModel({ cwd: temp });
    expect(res).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('returns defaults when JSON parsing fails', () => {
    const temp = makeTempProject();
    fs.writeFileSync(path.join(temp, 'testronaut-config.json'), '{bad json', 'utf8');

    const res = resolveProviderModel({ cwd: temp });
    expect(res.provider).toBe('openai');
    expect(res.model).toBe('gpt-4o');
  });

  it('trims env vars and treats empty strings as absent', () => {
    process.env.TESTRONAUT_PROVIDER = '  openai  ';
    process.env.TESTRONAUT_MODEL = '   gpt-5   ';
    let res = resolveProviderModel();
    expect(res).toEqual({ provider: 'openai', model: 'gpt-5' });

    process.env.TESTRONAUT_PROVIDER = '   ';
    process.env.TESTRONAUT_MODEL = '   ';
    res = resolveProviderModel();
    // falls back to defaults when env vars are just whitespace
    expect(res).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('prefers config when only provider is in env and model only in config', () => {
    process.env.TESTRONAUT_PROVIDER = 'gemini';
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-'));
    fs.writeFileSync(
      path.join(temp, 'testronaut-config.json'),
      JSON.stringify({ provider: 'openai', model: 'gemini-2.5-flash' }),
      'utf8'
    );
    const res = resolveProviderModel({ cwd: temp });
    expect(res).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('ignores unrelated keys in config and still resolves', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-'));
    fs.writeFileSync(
      path.join(temp, 'testronaut-config.json'),
      JSON.stringify({ provider: 'openai', model: 'gpt-4o', extra: { foo: 1 } }),
      'utf8'
    );
    const res = resolveProviderModel({ cwd: temp });
    expect(res).toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

});
