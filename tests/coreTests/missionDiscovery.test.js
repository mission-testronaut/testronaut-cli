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
    fs.writeFileSync(path.join(missionsDir, 'delta.mission.ts'), '// ts');

    const res = await discoverMissionFiles({ cwd: tmp });
    expect(res.root).toBe(path.resolve(tmp, 'missions'));
    expect(res.files).toEqual(['alpha.mission.js', 'delta.mission.ts']);
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

  it('orders configured patterns and places remaining missions at the wildcard', async () => {
    const tmp = makeTempDir();
    temps.push(tmp);
    const missionsDir = path.join(tmp, 'missions');
    fs.mkdirSync(path.join(missionsDir, 'account'), { recursive: true });
    for (const file of ['login.mission.js', 'logout.mission.js', 'search.mission.js']) {
      fs.writeFileSync(path.join(missionsDir, file), '// ok');
    }
    fs.writeFileSync(path.join(missionsDir, 'account', 'profile.mission.js'), '// ok');

    writeJson(path.join(tmp, 'testronaut-config.json'), {
      missions: {
        include: ['**/*.mission.js'],
        order: ['login.mission.js', 'account/**/*.mission.js', '*', 'logout.mission.js'],
      },
    });

    const res = await discoverMissionFiles({ cwd: tmp });
    expect(res.files).toEqual([
      'login.mission.js',
      'account/profile.mission.js',
      'search.mission.js',
      'logout.mission.js',
    ]);
  });

  it('warns about missing exact order entries while ignoring unmatched globs', async () => {
    const tmp = makeTempDir();
    temps.push(tmp);
    fs.mkdirSync(path.join(tmp, 'missions'));
    fs.writeFileSync(path.join(tmp, 'missions', 'actual.mission.js'), '// ok');
    writeJson(path.join(tmp, 'testronaut-config.json'), {
      missions: {
        order: ['missing.mission.js', 'optional/**/*.mission.js', '*'],
      },
    });

    const res = await discoverMissionFiles({ cwd: tmp });
    expect(res.files).toEqual(['actual.mission.js']);
    expect(res.warnings).toEqual([
      'Configured mission order entry was not discovered: missing.mission.js',
    ]);
  });
});
