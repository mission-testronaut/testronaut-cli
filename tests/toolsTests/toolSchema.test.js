import { describe, it, expect } from 'vitest';
import toolsSchema from '../../tools/toolSchema.js';

describe('tools/toolSchema', () => {
  it('includes resource_progress tool with empty params', () => {
    const entry = toolsSchema.find(t => t.function?.name === 'resource_progress');
    expect(entry?.type).toBe('function');
    expect(entry.function.parameters).toEqual({ type: 'object', properties: {} });
    expect(entry.function.description).toMatch(/remaining/i);
  });

  it('includes list_local_files tool', () => {
    const entry = toolsSchema.find(t => t.function?.name === 'list_local_files');
    expect(entry?.type).toBe('function');
    expect(entry.function.parameters?.properties).toHaveProperty('dir');
  });

  it('defines navigate and download_file with required fields', () => {
    const nav = toolsSchema.find(t => t.function?.name === 'navigate');
    const download = toolsSchema.find(t => t.function?.name === 'download_file');
    expect(nav?.function?.parameters?.required).toContain('url');
    expect(download?.function?.parameters?.properties).toHaveProperty('url');
  });
});
