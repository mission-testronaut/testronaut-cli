import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { discoverMissionFiles } from '../../core/missionDiscovery.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-missions-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

const temps = [];

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverMissionFiles', () => {
  it('falls back to legacy discovery when missions block is missing', async () => {
    const tmp = makeTempDir();
    temps.push(tmp);
    const missionsDir = path.join(tmp, 'missions');
    fs.mkdirSync(missionsDir, { recursive: true });
    fs.writeFileSync(path.join(missionsDir, 'alpha.mission.js'), '// ok');
    fs.writeFileSync(path.join(missionsDir, 'beta.txt'), '// ignore');
    fs.mkdirSync(path.join(missionsDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(missionsDir, 'nested', 'gamma.mission.js'), '// nested');
    fs.writeFileSync(path.join(missionsDir, 'delta.mission.ts'), '// ts not included by default');

    const res = await discoverMissionFiles({ cwd: tmp });
    expect(res.root).toBe(path.resolve(tmp, 'missions'));
    expect(res.files).toEqual(['alpha.mission.js']);
  });

  it('respects missions.root with include patterns', async () => {
    const tmp = makeTempDir();
    temps.push(tmp);
    const missionsDir = path.join(tmp, 'custom');
    fs.mkdirSync(path.join(missionsDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(missionsDir, 'root.mission.js'), '// root');
    fs.writeFileSync(path.join(missionsDir, 'nested', 'deep.mission.ts'), '// nested ts');

    writeJson(path.join(tmp, 'testronaut-config.json'), {
      missions: {
        root: './custom',
        include: ['*.mission.js', 'nested/**/*.mission.ts'],
      },
    });

    const res = await discoverMissionFiles({ cwd: tmp });
    expect(res.root).toBe(path.resolve(tmp, 'custom'));
    expect(res.files).toEqual(['nested/deep.mission.ts', 'root.mission.js']);
  });

  it('applies missions.exclude after includes', async () => {
    const tmp = makeTempDir();
    temps.push(tmp);
    const missionsDir = path.join(tmp, 'custom');
    fs.mkdirSync(path.join(missionsDir, 'ignore'), { recursive: true });
    fs.writeFileSync(path.join(missionsDir, 'keep.mission.js'), '// keep');
    fs.writeFileSync(path.join(missionsDir, 'ignore', 'skip.mission.js'), '// skip');
    fs.writeFileSync(path.join(missionsDir, 'keep.wip.mission.js'), '// skip by pattern');

    writeJson(path.join(tmp, 'testronaut-config.json'), {
      missions: {
        root: './custom',
        include: ['**/*.mission.js'],
        exclude: ['ignore/**', '**/*.wip.mission.js'],
      },
    });

    const res = await discoverMissionFiles({ cwd: tmp });
    expect(res.files).toEqual(['keep.mission.js']);
  });
});
