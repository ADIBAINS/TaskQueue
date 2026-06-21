import { describe, expect, it } from 'vitest';
import { parseJSONObject, readJSONValue } from '../src/input.js';

describe('CLI JSON input', () => {
  it('parses inline payloads', async () => {
    await expect(readJSONValue('{"operation":"cleanup"}')).resolves.toEqual({
      operation: 'cleanup',
    });
  });

  it('rejects arrays', async () => {
    await expect(readJSONValue('[]')).rejects.toThrow('must be an object');
  });

  it('parses chaining objects', () => {
    expect(parseJSONObject('{"nextJobType":"data"}', 'on-success')).toEqual({
      nextJobType: 'data',
    });
  });
});
