import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// Resolve from the **user project** (cwd)
const req = createRequire(path.join(process.cwd(), 'noop.js'));

// Prefer 'playwright' → '@playwright/test' → 'playwright-core' from the USER PROJECT (cwd)
function getPlaywrightInstallation() {
  console.log('🔍 Detecting installed Playwright version (from project)…');
  const tryPkg = (name) => {
    try {
      const p = req.resolve(`${name}/package.json`);
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
      const cliPath = bin ? path.resolve(path.dirname(p), bin) : null;
      console.log(`   • found ${name}@${pkg.version} → ${p}`);
      return { version: pkg.version, cliPath };
    } catch {
      return null;
    }
  };
  return (
    tryPkg('playwright') ||
    tryPkg('@playwright/test') ||
    tryPkg('playwright-core') ||
    { version: 'latest', cliPath: null }
  );
}

function pkgManagerForCwd(cwd = process.cwd()) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb')) return 'bun';
  return 'npm';
}

async function run(command, args, extraEnv = {}) {
  console.log(`\n> ${[command, ...args].join(' ')}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal || `code ${code}`}`));
    });
  });
}

export async function ensureBrowsers(
  { browser = 'chromium', withDeps = true } = {},
  { getInstallation = getPlaywrightInstallation, runCommand = run, cwd = process.cwd() } = {},
) {
  if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') return;

  const installation = getInstallation();
  const installArgs = ['install', browser, ...(withDeps ? ['--with-deps'] : [])];
  const localCacheEnv = { PLAYWRIGHT_BROWSERS_PATH: '0' }; // project-local cache

  try {
    if (!installation.cliPath) throw new Error('No local Playwright CLI was resolved');
    // Execute the CLI beside the package that will launch the browser. With
    // PLAYWRIGHT_BROWSERS_PATH=0, running an npx-temporary CLI downloads into
    // the temporary package instead of this project and leaves launch broken.
    await runCommand(process.execPath, [installation.cliPath, ...installArgs], localCacheEnv);
  } catch {
    const pm = pkgManagerForCwd(cwd);

    const [command, args] =
      pm === 'pnpm' ? ['pnpm', ['exec', 'playwright', ...installArgs]] :
      pm === 'yarn' ? ['yarn', ['playwright', ...installArgs]] :
      pm === 'bun'  ? ['bunx', ['playwright', ...installArgs]] :
                      ['npm', ['exec', '--yes', '--', 'playwright', ...installArgs]];

    await runCommand(command, args, localCacheEnv);
  }
}
