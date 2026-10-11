import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { loadConfig } from './config.js';

const DEFAULT_ROOT = 'missions';
const DEFAULT_INCLUDE = ['**/*.mission.js', '**/*.mission.ts'];

function orderMissionFiles(files, order, root) {
  const alphabetical = [...files].sort();
  if (!Array.isArray(order) || order.length === 0) {
    return { files: alphabetical, warnings: [] };
  }

  const remaining = new Set(alphabetical);
  const ordered = [];
  const warnings = [];

  for (let index = 0; index < order.length; index += 1) {
    const rawPattern = order[index];
    const pattern = String(rawPattern ?? '').trim();
    if (!pattern) continue;

    if (pattern === '*') {
      const reserved = new Set(order.slice(index + 1).flatMap(laterPattern => {
        const later = String(laterPattern ?? '').trim();
        if (!later || later === '*') return [];
        return fg.sync(later, { cwd: root, onlyFiles: true });
      }));
      for (const file of alphabetical) {
        if (!reserved.has(file) && remaining.delete(file)) ordered.push(file);
      }
      continue;
    }

    const matches = fg.sync(pattern, { cwd: root, onlyFiles: true })
      .filter(file => remaining.has(file))
      .sort();
    for (const file of matches) {
      remaining.delete(file);
      ordered.push(file);
    }

    if (!fg.isDynamicPattern(pattern) && !alphabetical.includes(pattern)) {
      warnings.push(`Configured mission order entry was not discovered: ${pattern}`);
    }
  }

  // A partial order only moves the named groups; all other missions retain
  // deterministic legacy ordering after the configured entries.
  for (const file of alphabetical) {
    if (remaining.delete(file)) ordered.push(file);
  }
  return { files: ordered, warnings };
}

/**
 * Discover mission files based on testronaut-config.json.
 * - When no missions block exists, preserve legacy behavior:
 *   read the ./missions folder (non-recursive) for JavaScript/TypeScript missions.
 * - When missions is defined, apply root/include/exclude globs relative to root.
 *
 * @param {object} opts
 * @param {string} [opts.cwd=process.cwd()] - project root for config + resolution
 * @returns {Promise<{ root:string, files:string[], warnings:string[] }>} root is absolute; files are relative to root
 */
export async function discoverMissionFiles({ cwd = process.cwd() } = {}) {
  const defaultRoot = path.resolve(cwd, DEFAULT_ROOT);
  const cfg = await loadConfig(cwd);
  const missionsCfg = cfg?.missions;

  // Legacy behavior remains non-recursive, now with first-class TypeScript support.
  if (!missionsCfg) {
    if (!fs.existsSync(defaultRoot)) {
      return { root: defaultRoot, files: [], warnings: [] };
    }
    const files = fs.readdirSync(defaultRoot)
      .filter(f => f.endsWith('.mission.js') || f.endsWith('.mission.ts'))
      .sort();
    return { root: defaultRoot, files, warnings: [] };
  }

  const root = path.resolve(cwd, missionsCfg.root || DEFAULT_ROOT);
  if (!fs.existsSync(root)) {
    return { root, files: [], warnings: [] };
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
  const ordered = orderMissionFiles(unique, missionsCfg.order, root);

  return { root, ...ordered };
}

export const __test__ = { orderMissionFiles };
