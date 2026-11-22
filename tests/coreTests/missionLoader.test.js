import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMissionModule } from '../../core/missionLoader.js';

const tempDirs = [];

function makeProject(packageJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-loader-'));
  tempDirs.push(dir);
  if (packageJson) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson));
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('loadMissionModule', () => {
  it.each([
    ['without a package type', undefined],
    ['inside a CommonJS project', { type: 'commonjs' }],
  ])('loads ESM-style .mission.js %s', async (_label, packageJson) => {
    const dir = makeProject(packageJson);
    const missionPath = path.join(dir, 'sample.mission.js');
    fs.writeFileSync(missionPath, 'export const tags = ["smoke"]; export async function executeMission() { return "ok"; }');

    const mission = await loadMissionModule(missionPath);

    expect(mission.tags).toEqual(['smoke']);
    await expect(mission.executeMission()).resolves.toBe('ok');
  });

  it('loads a typed .mission.ts file with relative imports', async () => {
    const dir = makeProject({ type: 'commonjs' });
    fs.writeFileSync(path.join(dir, 'goal.ts'), 'export const goal: string = "TypeScript works";');
    const missionPath = path.join(dir, 'sample.mission.ts');
    fs.writeFileSync(missionPath, [
      'import { goal } from "./goal.ts";',
      'export const tags: string[] = ["typescript"];',
      'export async function executeMission(): Promise<string> { return goal; }',
    ].join('\n'));

    const mission = await loadMissionModule(missionPath);

    expect(mission.tags).toEqual(['typescript']);
    await expect(mission.executeMission()).resolves.toBe('TypeScript works');
  });

  it('rejects a named mission import when the source forgot to export it', async () => {
    const dir = makeProject();
    fs.writeFileSync(path.join(dir, 'login.mission.js'), 'const loginMission = "Log in";');
    const missionPath = path.join(dir, 'dashboard.mission.js');
    fs.writeFileSync(missionPath, [
      'import { loginMission } from "./login.mission.js";',
      'export async function executeMission() { return loginMission; }',
    ].join('\n'));

    await expect(loadMissionModule(missionPath)).rejects.toThrow(
      'Mission import error in dashboard.mission.js: "./login.mission.js" does not export "loginMission". Add the export keyword to the declaration in login.mission.js.',
    );
  });

  it('rejects a missing export nested inside a chain of mission imports', async () => {
    const dir = makeProject();
    fs.writeFileSync(path.join(dir, 'login.mission.js'), 'const loginPrerequisite = "Log in";');
    fs.writeFileSync(path.join(dir, 'addTask.mission.js'), [
      'import { loginPrerequisite } from "./login.mission.js";',
      'export const addTaskMission = `${loginPrerequisite}: add a task`;',
    ].join('\n'));
    const missionPath = path.join(dir, 'smokeSuite.mission.js');
    fs.writeFileSync(missionPath, [
      'import { addTaskMission } from "./addTask.mission.js";',
      'export async function executeMission() { return addTaskMission; }',
    ].join('\n'));

    await expect(loadMissionModule(missionPath)).rejects.toThrow(
      'Mission import error in addTask.mission.js: "./login.mission.js" does not export "loginPrerequisite". Add the export keyword to the declaration in login.mission.js.',
    );
  });
});
