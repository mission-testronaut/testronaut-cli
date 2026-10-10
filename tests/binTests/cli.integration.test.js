import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../bin/cli.js', import.meta.url));
const tempDirs = [];

function makeProject() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-cli-integration-'));
  tempDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, 'missions'));
  fs.writeFileSync(path.join(cwd, 'missions', 'login.mission.js'), [
    'export const tags = ["authentication", "smoke"];',
    'export function executeMission() { throw new Error("must not execute"); }',
  ].join('\n'));
  fs.writeFileSync(path.join(cwd, 'testronaut-config.json'), JSON.stringify({
    provider: 'openai', model: 'gpt-5.6', outputDir: 'artifacts/reports', sessionToken: 'private',
  }));
  return cwd;
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('CLI inspection commands', () => {
  it('lists mission tags without executing the mission', () => {
    const result = run(makeProject(), ['list', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).missions).toEqual([
      { file: 'login.mission.js', tags: ['authentication', 'smoke'], selected: true },
    ]);
  });

  it('applies tag filters to list output', () => {
    const result = run(makeProject(), ['list', '--tag=checkout', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).missions[0].selected).toBe(false);
  });

  it('does not discard a following inline flag', () => {
    const result = run(makeProject(), ['--model=gpt-5.6', '--turns=30', '--dry-run', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).missions[0].file).toBe('missions/login.mission.js');
  });

  it('reports effective config without exposing the session token', () => {
    const result = run(makeProject(), ['config', '--json']);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.outputDir.value).toMatch(/artifacts[/\\]reports$/);
    expect(output.authenticated).toBe(true);
    expect(result.stdout).not.toContain('private');
  });

  it('reports opt-in guardrail readiness without exposing the Jev key', () => {
    const cwd = makeProject();
    fs.writeFileSync(path.join(cwd, 'testronaut-config.json'), JSON.stringify({
      provider: 'openai', model: 'gpt-5.6', guardrails: { enabled: true, completionProbability: 0.85 },
    }));
    const result = spawnSync(process.execPath, [cliPath, 'config', '--json'], {
      cwd, encoding: 'utf8', env: { ...process.env, TESTRONAUT_JEV_API_KEY: 'private-jev-key' },
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.guardrails).toMatchObject({ enabled: true, mode: 'live', completionProbability: 0.85, credentialConfigured: true, credentialSource: 'TESTRONAUT_JEV_API_KEY' });
    expect(result.stdout).not.toContain('private-jev-key');
  });

  it('suggests a close mission name and exits nonzero during dry-run', () => {
    const result = run(makeProject(), ['logn.mission.js', '--dry-run', '--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).missions[0]).toMatchObject({
      status: 'missing', suggestion: 'login.mission.js',
    });
  });

  it('loads project .env values before evaluating mission modules', () => {
    const cwd = makeProject();
    fs.writeFileSync(path.join(cwd, '.env'), 'MISSION_DESTINATION=https://example.test\n');
    fs.writeFileSync(path.join(cwd, 'missions', 'login.mission.js'), [
      'const destination = process.env.MISSION_DESTINATION;',
      'export const tags = ["authentication"];',
      'export async function executeMission() {',
      '  return { missionName: destination, status: "passed", steps: [] };',
      '}',
    ].join('\n'));

    const result = run(cwd, ['--tags', 'authentication', '--json', '--quiet']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).missions[0].missionName).toBe('https://example.test');
  });

  it('records shared-auth session mode in the report', () => {
    const cwd = makeProject();
    fs.writeFileSync(path.join(cwd, 'missions', 'login.mission.js'), [
      'export const tags = ["authentication"];',
      'export async function executeMission() {',
      '  return { missionName: "login", submissionType: "mission", status: "passed", steps: [] };',
      '}',
    ].join('\n'));
    const result = run(cwd, ['--session=shared-auth', '--json', '--quiet']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).session).toEqual({ mode: 'shared-auth' });
  });
});
