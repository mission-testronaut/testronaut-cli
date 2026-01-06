import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { loadConfig } from './config.js';

const DEFAULT_ROOT = 'missions';
const DEFAULT_INCLUDE = ['**/*.mission.js', '**/*.mission.ts'];

/**
 * Discover mission files based on testronaut-config.json.
 * - When no missions block exists, preserve legacy behavior:
 *   read the ./missions folder (non-recursive) for *.mission.js files.
 * - When missions is defined, apply root/include/exclude globs relative to root.
 *
 * @param {object} opts
 * @param {string} [opts.cwd=process.cwd()] - project root for config + resolution
 * @returns {Promise<{ root:string, files:string[] }>} root is absolute; files are relative to root
 */
export async function discoverMissionFiles({ cwd = process.cwd() } = {}) {
  const defaultRoot = path.resolve(cwd, DEFAULT_ROOT);
  const cfg = await loadConfig(cwd);
  const missionsCfg = cfg?.missions;

  // Legacy behavior: no missions block → non-recursive *.mission.js in ./missions
  if (!missionsCfg) {
    if (!fs.existsSync(defaultRoot)) {
      return { root: defaultRoot, files: [] };
    }
    const files = fs.readdirSync(defaultRoot)
      .filter(f => f.endsWith('.mission.js'))
      .sort();
    return { root: defaultRoot, files };
  }

  const root = path.resolve(cwd, missionsCfg.root || DEFAULT_ROOT);
  if (!fs.existsSync(root)) {
    return { root, files: [] };
  }

  const include = Array.isArray(missionsCfg.include) && missionsCfg.include.length
    ? missionsCfg.include
    : DEFAULT_INCLUDE;
  const exclude = Array.isArray(missionsCfg.exclude) ? missionsCfg.exclude : [];

  const matches = await fg(include, {
    cwd: root,
    ignore: exclude,
    onlyFiles: true,
  });

  const unique = Array.from(new Set(matches));
  unique.sort();

  return { root, files: unique };
}
