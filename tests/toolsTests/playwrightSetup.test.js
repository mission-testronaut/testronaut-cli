import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureBrowsers } from '../../tools/playwrightSetup.js';

const tempDirs = [];

afterEach(() => {
  delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempProject(lockfile) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'testronaut-playwright-'));
  tempDirs.push(cwd);
  if (lockfile) fs.writeFileSync(path.join(cwd, lockfile), '');
  return cwd;
}

describe('Playwright browser setup', () => {
  it('installs the browser matching the locally resolved Playwright version', async () => {
    const runCommand = vi.fn().mockResolvedValue(undefined);
    const cliPath = '/project/node_modules/playwright/cli.js';

    await ensureBrowsers(
      { browser: 'chromium', withDeps: true },
      { getInstallation: () => ({ version: '1.63.0', cliPath }), runCommand, cwd: tempProject('package-lock.json') },
    );

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      process.execPath,
      [cliPath, 'install', 'chromium', '--with-deps'],
      { PLAYWRIGHT_BROWSERS_PATH: '0' },
    );
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm', ['exec', 'playwright', 'install', 'chromium']],
    ['yarn.lock', 'yarn', ['playwright', 'install', 'chromium']],
    ['bun.lockb', 'bunx', ['playwright', 'install', 'chromium']],
    ['package-lock.json', 'npm', ['exec', '--yes', '--', 'playwright', 'install', 'chromium']],
  ])('uses the project package manager fallback for %s', async (lockfile, command, args) => {
    const runCommand = vi.fn()
      .mockRejectedValueOnce(new Error('npx unavailable'))
      .mockResolvedValueOnce(undefined);

    await ensureBrowsers(
      { browser: 'chromium', withDeps: false },
      {
        getInstallation: () => ({ version: '1.63.0', cliPath: '/project/node_modules/playwright/cli.js' }),
        runCommand,
        cwd: tempProject(lockfile),
      },
    );

    expect(runCommand).toHaveBeenNthCalledWith(2, command, args, { PLAYWRIGHT_BROWSERS_PATH: '0' });
  });

  it('does not invoke an installer when browser downloads are disabled', async () => {
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
    const runCommand = vi.fn();

    await ensureBrowsers({}, { getInstallation: vi.fn(), runCommand, cwd: tempProject() });

    expect(runCommand).not.toHaveBeenCalled();
  });
});
