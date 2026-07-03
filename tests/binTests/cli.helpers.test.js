import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

// Import helper exports from cli.js
import { __test__ } from '../../bin/cli.js';

describe('cli helpers', () => {
  it('guessMimeType returns expected types', () => {
    const { guessMimeType } = __test__;
    expect(guessMimeType('file.html')).toContain('text/html');
    expect(guessMimeType('file.json')).toContain('application/json');
    expect(guessMimeType('file.unknown')).toBe('application/octet-stream');
  });

  it('safeJoin prevents traversal', () => {
    const { safeJoin } = __test__;
    const root = '/tmp/root';
    expect(safeJoin(root, '/sub/ok.txt')).toBe(path.resolve('/tmp/root/sub/ok.txt'));
    expect(safeJoin(root, '/../etc/passwd')).toBeNull();
  });

  it('findLatestReportPair finds latest html/json', () => {
    const { findLatestReportPair } = __test__;
    const tmp = fs.mkdtempSync(path.join(process.cwd(), 'testronaut-report-'));
    const r1 = path.join(tmp, 'run_100.html');
    const r2 = path.join(tmp, 'run_200.html');
    fs.writeFileSync(r1, 'a');
    fs.writeFileSync(r2, 'b');
    fs.writeFileSync(path.join(tmp, 'run_200.json'), '{}');

    const latest = findLatestReportPair(tmp);
    expect(latest?.htmlFile).toBe('run_200.html');
    expect(latest?.jsonFile).toBe('run_200.json');
  });

  it('parses booleans in a tolerant way', () => {
    const { parseBool } = __test__;
    expect(parseBool('true')).toBe(true);
    expect(parseBool('0')).toBe(false);
    expect(parseBool('off')).toBe(false);
    expect(parseBool('')).toBeNull();
    expect(parseBool('maybe')).toBeNull();
  });

  it('parses vercel bypass flags and removes them from args', () => {
    const { parseVercelBypassArgs } = __test__;
    const res = parseVercelBypassArgs(['--dev', '--vercel-bypass=secret123', 'login']);
    expect(res.secret).toBe('secret123');
    expect(res.args).toEqual(['--dev', 'login']);
    expect(res.invalid).toBe(false);
  });

  it('parses vercel bypass value from next arg', () => {
    const { parseVercelBypassArgs } = __test__;
    const res = parseVercelBypassArgs(['--vercel_bypass', 'abc', 'login']);
    expect(res.secret).toBe('abc');
    expect(res.args).toEqual(['login']);
    expect(res.invalid).toBe(false);
  });

  it('handles missing vercel bypass value', () => {
    const { parseVercelBypassArgs } = __test__;
    const res = parseVercelBypassArgs(['--vercel-bypass']);
    expect(res.secret).toBeUndefined();
    expect(res.args).toEqual([]);
    expect(res.invalid).toBe(true);
  });

  it('parses provider flag with inline value and removes it from args', () => {
    const { parseProviderArgs } = __test__;
    const res = parseProviderArgs(['--provider=openai', 'login']);
    expect(res.provider).toBe('openai');
    expect(res.args).toEqual(['login']);
    expect(res.invalid).toBe(false);
  });

  it('parses provider flag value from next arg', () => {
    const { parseProviderArgs } = __test__;
    const res = parseProviderArgs(['--provider', 'gemini', 'login']);
    expect(res.provider).toBe('gemini');
    expect(res.args).toEqual(['login']);
    expect(res.invalid).toBe(false);
  });

  it('accepts supported provider names', () => {
    const { parseProviderArgs } = __test__;
    const res1 = parseProviderArgs(['--provider', 'openai', 'login']);
    expect(res1.provider).toBe('openai');
    expect(res1.invalid).toBe(false);

    const res2 = parseProviderArgs(['--provider=gemini', 'login']);
    expect(res2.provider).toBe('gemini');
    expect(res2.invalid).toBe(false);
  });

  it('flags invalid provider name', () => {
    const { parseProviderArgs } = __test__;
    const res = parseProviderArgs(['--provider', 'bad provider', 'login']);
    expect(res.provider).toBeUndefined();
    expect(res.args).toEqual(['login']);
    expect(res.invalid).toBe(true);
  });

  it('handles missing provider value', () => {
    const { parseProviderArgs } = __test__;
    const res = parseProviderArgs(['--provider']);
    expect(res.provider).toBeUndefined();
    expect(res.args).toEqual([]);
    expect(res.invalid).toBe(true);
  });

  it('builds the vercel bypass header when provided', () => {
    const { createVercelBypassHeader } = __test__;
    expect(createVercelBypassHeader('abc')).toEqual({ 'x-vercel-protection-bypass': 'abc' });
    expect(createVercelBypassHeader('')).toEqual({});
  });

  it('parses run options from -o and removes them from args', () => {
    const { parseRunOptionsArgs } = __test__;
    const res = parseRunOptionsArgs(['-o', 'mfa=github-test-mfa', 'login.mission.js']);

    expect(res.options).toEqual({ mfa: 'github-test-mfa' });
    expect(res.args).toEqual(['login.mission.js']);
    expect(res.invalid).toBe(false);
  });

  it('parses comma-separated inline run options', () => {
    const { parseRunOptionsArgs } = __test__;
    const res = parseRunOptionsArgs(['--options=mfa=github-test-mfa,foo=bar', 'login']);

    expect(res.options).toEqual({ mfa: 'github-test-mfa', foo: 'bar' });
    expect(res.args).toEqual(['login']);
    expect(res.invalid).toBe(false);
  });

  it('flags invalid run options', () => {
    const { parseRunOptionsArgs } = __test__;
    const res = parseRunOptionsArgs(['--options', 'mfa', 'login']);

    expect(res.options).toEqual({});
    expect(res.args).toEqual(['login']);
    expect(res.invalid).toBe(true);
  });

  describe('detectCliName', () => {
    const { detectCliName } = __test__;

    it('returns "npx testronaut" when npm_command is exec (npx invocation)', () => {
      expect(detectCliName('exec', '/some/path/cli.js')).toBe('npx testronaut');
    });

    it('returns "testronaut" when argv[1] basename is testronaut (global install)', () => {
      expect(detectCliName(undefined, '/usr/local/bin/testronaut')).toBe('testronaut');
    });

    it('returns "npx testronaut" when argv[1] is cli.js (direct node invocation)', () => {
      expect(detectCliName(undefined, '/home/user/testronaut-cli/bin/cli.js')).toBe('npx testronaut');
    });

    it('npm_command=exec takes precedence over a global-bin argv[1]', () => {
      expect(detectCliName('exec', '/usr/local/bin/testronaut')).toBe('npx testronaut');
    });

    it('returns "npx testronaut" when argv[1] is undefined', () => {
      expect(detectCliName(undefined, undefined)).toBe('npx testronaut');
    });

    it('returns "npx testronaut" when argv[1] is empty string', () => {
      expect(detectCliName(undefined, '')).toBe('npx testronaut');
    });
  });
});
