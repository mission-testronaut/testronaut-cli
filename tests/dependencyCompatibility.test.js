import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

describe('runtime dependency compatibility', () => {
  it('records the Node runtime required by the installed Playwright version', () => {
    const playwright = lock.packages['node_modules/playwright'];
    expect(playwright.engines.node).toBe('>=20');
  });

  it('keeps the manifest, lockfile root, and installed Playwright versions aligned', () => {
    expect(pkg.dependencies.playwright).toBe('^1.63.0');
    expect(lock.packages[''].dependencies.playwright).toBe(pkg.dependencies.playwright);
    expect(lock.packages['node_modules/playwright'].version).toBe('1.63.0');
    expect(lock.packages['node_modules/playwright-core'].version).toBe('1.63.0');
  });

  it('declares the minimum Node runtime required by Inquirer 14', () => {
    const inquirer = lock.packages['node_modules/inquirer'];
    expect(pkg.engines.node).toBe('>=20.18.1');
    expect(lock.packages[''].engines.node).toBe(pkg.engines.node);
    expect(pkg.dependencies.inquirer).toBe('^14.2.2');
    expect(lock.packages[''].dependencies.inquirer).toBe(pkg.dependencies.inquirer);
    expect(inquirer.version).toBe('14.2.2');
    expect(inquirer.engines.node).toContain('^20.17.0');
  });

  it('pins the patched Undici release and its minimum Node runtime', () => {
    const cheerio = lock.packages['node_modules/cheerio'];
    const undici = lock.packages['node_modules/undici'];

    expect(cheerio.dependencies.undici).toBe('^7.19.0');
    expect(undici.version).toBe('7.30.2');
    expect(undici.engines.node).toBe('>=20.18.1');
    expect(pkg.engines.node).toBe(undici.engines.node);
  });

  it('keeps Vitest on a patched Vite and Rolldown toolchain', () => {
    const vitest = lock.packages['node_modules/vitest'];
    const vite = lock.packages['node_modules/vite'];
    const rolldown = lock.packages['node_modules/rolldown'];

    expect(vitest.dependencies.vite).toContain('^8.0.0');
    expect(vite.version).toBe('8.3.8');
    expect(vite.dev).toBe(true);
    expect(rolldown.version).toBe('1.2.19');
    expect(rolldown.dev).toBe(true);
  });
});
