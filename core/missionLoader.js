import { createJiti } from 'jiti';
import fs from 'node:fs';
import path from 'node:path';

// Mission files are user-authored configuration/code, so Testronaut owns their
// module loading semantics instead of inheriting the host project's package type.
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  sourceMaps: true,
});

const NAMED_IMPORT_RE = /\bimport\s+(?!type\b)\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2/g;

function importedNames(importList) {
  return importList.split(',')
    .map(entry => entry.trim())
    .filter(entry => entry && !entry.startsWith('type '))
    .map(entry => entry.split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

async function validateNamedMissionImports(modulePath, visited = new Set()) {
  const canonicalPath = path.resolve(modulePath);
  if (visited.has(canonicalPath)) return;
  visited.add(canonicalPath);

  const source = fs.readFileSync(canonicalPath, 'utf8');
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const specifier = match[3];
    if (!specifier.startsWith('.')) continue;

    const dependencyPath = path.resolve(path.dirname(canonicalPath), specifier);
    await validateNamedMissionImports(dependencyPath, visited);
    const dependency = await jiti.import(dependencyPath);
    for (const importedName of importedNames(match[1])) {
      if (Object.prototype.hasOwnProperty.call(dependency, importedName)) continue;
      throw new SyntaxError(
        `Mission import error in ${path.basename(canonicalPath)}: "${specifier}" does not export "${importedName}". `
        + `Add the export keyword to the declaration in ${path.basename(dependencyPath)}.`,
      );
    }
  }
}

/**
 * Load an ESM-style JavaScript or TypeScript mission regardless of whether the
 * consuming project is ESM, CommonJS, or has no package.json `type` field.
 */
export async function loadMissionModule(modulePath) {
  await validateNamedMissionImports(modulePath);
  return jiti.import(modulePath);
}
