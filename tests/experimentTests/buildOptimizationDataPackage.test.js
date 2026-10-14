import { describe, expect, it } from 'vitest';
import { __dataPackageInternals } from '../../experiments/buildOptimizationDataPackage.js';

describe('optimization data package statistics', () => {
  it('calculates sample statistics', () => {
    expect(__dataPackageInternals.mean([1, 2, 3])).toBe(2);
    expect(__dataPackageInternals.sampleSd([1, 2, 3])).toBe(1);
  });

  it('calculates paired percentage deltas by block', () => {
    const condition = [
      { block: 1, tokens: 80 }, { block: 2, tokens: 160 },
      { block: 3, tokens: 240 }, { block: 4, tokens: 320 }, { block: 5, tokens: 400 },
    ];
    const control = [
      { block: 1, tokens: 100 }, { block: 2, tokens: 200 },
      { block: 3, tokens: 300 }, { block: 4, tokens: 400 }, { block: 5, tokens: 500 },
    ];
    expect(__dataPackageInternals.pairedDelta(condition, control, 'tokens')).toEqual({
      average: -20,
      low: -20,
      high: -20,
    });
  });
});
