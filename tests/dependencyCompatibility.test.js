import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

describe('runtime dependency compatibility', () => {
  it('declares the Node runtime required by the installed Playwright version', () => {
    const playwright = lock.packages['node_modules/playwright'];
    expect(pkg.engines.node).toBe('>=20');
    expect(playwright.engines.node).toBe('>=20');
  });

  it('keeps the manifest, lockfile root, and installed Playwright versions aligned', () => {
    expect(pkg.dependencies.playwright).toBe('^1.63.0');
    expect(lock.packages[''].dependencies.playwright).toBe(pkg.dependencies.playwright);
    expect(lock.packages['node_modules/playwright'].version).toBe('1.63.0');
    expect(lock.packages['node_modules/playwright-core'].version).toBe('1.63.0');
  });
});
