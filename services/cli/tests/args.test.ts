import { describe, expect, it } from 'vitest';
import { getBoolean, getInteger, getString, parseArgs } from '../src/args.js';

describe('CLI argument parser', () => {
  it('parses commands, long options, and aliases', () => {
    const args = parseArgs([
      'job',
      'submit',
      'email',
      '--payload={"to":"a@example.com"}',
      '-p',
      '1',
      '-jq',
    ]);

    expect(args.positionals).toEqual(['job', 'submit', 'email']);
    expect(getString(args, 'payload')).toBe('{"to":"a@example.com"}');
    expect(getInteger(args, 'priority')).toBe(1);
    expect(getBoolean(args, 'json')).toBe(true);
    expect(getBoolean(args, 'quiet')).toBe(true);
  });

  it('rejects missing option values', () => {
    expect(() => parseArgs(['job', 'submit', 'email', '--payload-file'])).toThrow(
      'requires a value',
    );
  });

  it('validates integer ranges', () => {
    const args = parseArgs(['--priority', '8']);
    expect(() => getInteger(args, 'priority', { min: 1, max: 5 })).toThrow('must be at most 5');
  });
});
