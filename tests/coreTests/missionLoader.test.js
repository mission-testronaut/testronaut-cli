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
});
