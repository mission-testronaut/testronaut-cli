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
});
