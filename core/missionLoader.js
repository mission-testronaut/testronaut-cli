import { createJiti } from 'jiti';

// Mission files are user-authored configuration/code, so Testronaut owns their
// module loading semantics instead of inheriting the host project's package type.
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  sourceMaps: true,
});

/**
 * Load an ESM-style JavaScript or TypeScript mission regardless of whether the
 * consuming project is ESM, CommonJS, or has no package.json `type` field.
 */
export async function loadMissionModule(modulePath) {
  return jiti.import(modulePath);
}
