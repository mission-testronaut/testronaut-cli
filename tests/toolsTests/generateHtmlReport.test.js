import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { generateHtmlReport } from '../../tools/generateHtmlReport.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-report-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe('generateHtmlReport', () => {
  it('writes an HTML report containing mission and retry metadata', () => {
    const report = {
      runId: 'run_test',
      missions: [
        {
          missionName: 'Mission A',
          submissionType: 'mission',
          submissionName: 'Main',
          status: 'passed',
          steps: [
            {
              turn: 0,
              retryAttempt: 2,
              retryLimit: 5,
              events: ['did something'],
              result: '⚠️ Turn Issues',
              summary: 'Do thing',
              tokensUsed: 10,
              totalTokensUsed: 20,
            },
          ],
        },
      ],
    };

    const outPath = path.join(tmpDir, 'report.html');
    const written = generateHtmlReport(report, outPath);

    expect(written).toBe(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    const html = fs.readFileSync(outPath, 'utf8');

    expect(html).toContain('Testronaut Report');
    expect(html).toContain('Mission A');
    expect(html).toContain('Turn 1 (re-attempt 1/5)');
    expect(html).toContain('⚠️ Turn Issues');
  });

  it('escapes unsafe text in output', () => {
    const report = {
      runId: 'run<&>',
      missions: [
        {
          missionName: 'Mission <X>',
          submissionType: 'mission',
          submissionName: 'Main',
          status: 'passed',
          steps: [
            {
              turn: 0,
              retryAttempt: 1,
              events: ['<script>alert(1)</script>'],
              result: '✅ Passed',
              summary: '<b>bold</b>',
            },
          ],
        },
      ],
    };

    const outPath = path.join(tmpDir, 'safe.html');
    generateHtmlReport(report, outPath);
    const html = fs.readFileSync(outPath, 'utf8');

    expect(html).toContain('run&lt;&amp;&gt;');
    expect(html).toContain('Mission &lt;X&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });
});
