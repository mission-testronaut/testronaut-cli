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

  it('builds the vercel bypass header when provided', () => {
    const { createVercelBypassHeader } = __test__;
    expect(createVercelBypassHeader('abc')).toEqual({ 'x-vercel-protection-bypass': 'abc' });
    expect(createVercelBypassHeader('')).toEqual({});
  });
});
