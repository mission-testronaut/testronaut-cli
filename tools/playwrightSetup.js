import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';

const exec = promisify(execCb);

// Resolve from the **user project** (cwd)
const req = createRequire(path.join(process.cwd(), 'noop.js'));

// Prefer 'playwright' → '@playwright/test' → 'playwright-core' from the USER PROJECT (cwd)
function getPlaywrightVersion() {
  console.log('🔍 Detecting installed Playwright version (from project)…');
  const tryPkg = (name) => {
    try {
      const p = req.resolve(`${name}/package.json`);
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      console.log(`   • found ${name}@${v} → ${p}`);
      return v;
    } catch {
      return null;
    }
  };
  return (
    tryPkg('playwright') ||
    tryPkg('@playwright/test') ||
    tryPkg('playwright-core') ||
    'latest'
  );
}

function pkgManagerForCwd(cwd = process.cwd()) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb')) return 'bun';
  return 'npm';
}

async function run(cmd, extraEnv = {}) {
  console.log(`\n> ${cmd}`);
  await exec(cmd, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
}

export async function ensureBrowsers(
  { browser = 'chromium', withDeps = true } = {},
  { getVersion = getPlaywrightVersion, runCommand = run, cwd = process.cwd() } = {},
) {
  if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') return;

  const version = getVersion();
  const withDepsFlag = withDeps ? ' --with-deps' : '';
  const localCacheEnv = { PLAYWRIGHT_BROWSERS_PATH: '0' }; // project-local cache

  const npxCmd = `npx -y playwright@${version} install ${browser}${withDepsFlag}`;
  try {
    await runCommand(npxCmd, localCacheEnv);
  } catch {
    const pm = pkgManagerForCwd(cwd);

    const fallback =
      pm === 'pnpm' ? `pnpm exec playwright install ${browser}${withDepsFlag}` :
      pm === 'yarn' ? `yarn playwright install ${browser}${withDepsFlag}` :
      pm === 'bun'  ? `bunx playwright install ${browser}${withDepsFlag}` :
                      `npm exec --yes playwright@${version} install ${browser}${withDepsFlag}`;

    await runCommand(fallback, localCacheEnv);
  }
}
