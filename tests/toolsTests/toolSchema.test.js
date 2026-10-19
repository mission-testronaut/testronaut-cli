import { describe, it, expect } from 'vitest';
import toolsSchema from '../../tools/toolSchema.js';

describe('tools/toolSchema', () => {
  it('does not advertise the unimplemented get_dom_chunk tool', () => {
    expect(toolsSchema.map(tool => tool.function.name)).not.toContain('get_dom_chunk');
  });

  it('exposes structured recovery recording', () => {
    const entry = toolsSchema.find(tool => tool.function.name === 'record_recovery');
    expect(entry.function.parameters.required).toEqual(['action', 'reason']);
    expect(entry.function.parameters.properties).toHaveProperty('screenshot');
  });

  it('exposes reload as a first-class browser action', () => {
    const entry = toolsSchema.find(tool => tool.function.name === 'reload');
    expect(entry.function.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('allows get_dom calls to be scoped by selector', () => {
    const entry = toolsSchema.find(tool => tool.function.name === 'get_dom');
    expect(entry.function.parameters.properties.selector.type).toBe('string');
  });
  it('includes press_key with a required key and optional selector', () => {
    const entry = toolsSchema.find(tool => tool.function.name === 'press_key');
    expect(entry?.function.parameters.required).toEqual(['key']);
    expect(entry.function.parameters.properties.key.type).toBe('string');
    expect(entry.function.parameters.properties.selector.type).toBe('string');
  });
  it('exposes iframe targeting and iframe text search', () => {
    const fill = toolsSchema.find(tool => tool.function.name === 'fill');
    const click = toolsSchema.find(tool => tool.function.name === 'click');
    const checkText = toolsSchema.find(tool => tool.function.name === 'check_text');
    expect(fill.function.parameters.properties.frame.type).toBe('string');
    expect(click.function.parameters.properties.frame.type).toBe('string');
    expect(checkText.function.parameters.properties.searchAllFrames.default).toBe(true);
  });
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

  it('includes request_human_input for verification codes', () => {
    const entry = toolsSchema.find(t => t.function?.name === 'request_human_input');
    expect(entry?.type).toBe('function');
    expect(entry.function.description).toMatch(/verification code/i);
    expect(entry.function.parameters?.properties?.codeType?.enum).toContain('totp');
    expect(entry.function.parameters?.properties?.maxLength?.default).toBe(64);
  });

  it('includes get_mfa_code for automated TOTP retrieval', () => {
    const entry = toolsSchema.find(t => t.function?.name === 'get_mfa_code');
    expect(entry?.type).toBe('function');
    expect(entry.function.description).toMatch(/TOTP MFA code/i);
    expect(entry.function.parameters?.properties).toHaveProperty('nickname');
    expect(entry.function.parameters?.properties?.minSecondsRemaining?.default).toBe(5);
  });

  it('includes get_email_code for hosted inbox retrieval', () => {
    const entry = toolsSchema.find(t => t.function?.name === 'get_email_code');
    expect(entry).toBeTruthy();
    expect(entry.function.description).toMatch(/email authentication code/i);
  });

  it('includes opaque lookup and constrained open tools for email links', () => {
    const lookup = toolsSchema.find(t => t.function?.name === 'get_email_link');
    const open = toolsSchema.find(t => t.function?.name === 'open_email_link');
    expect(lookup?.function?.description).toMatch(/opaque link IDs/i);
    expect(open?.function?.parameters?.required).toContain('linkId');
    expect(open?.function?.parameters?.properties).not.toHaveProperty('url');
  });

  it('defines navigate and download_file with required fields', () => {
    const nav = toolsSchema.find(t => t.function?.name === 'navigate');
    const download = toolsSchema.find(t => t.function?.name === 'download_file');
    expect(nav?.function?.parameters?.required).toContain('url');
    expect(download?.function?.parameters?.properties).toHaveProperty('url');
  });
});
