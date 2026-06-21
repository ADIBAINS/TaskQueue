import { describe, expect, it } from 'vitest';
import { deriveWebSocketUrl, resolveRuntimeConfig } from '../src/config.js';

describe('CLI configuration', () => {
  it('derives local and secure WebSocket endpoints', () => {
    expect(deriveWebSocketUrl('http://localhost:3000')).toBe('ws://localhost:3400');
    expect(deriveWebSocketUrl('https://queue.example.com')).toBe('wss://queue.example.com');
  });

  it('resolves profile values and explicit overrides', () => {
    const runtime = resolveRuntimeConfig(
      {
        currentProfile: 'prod',
        profiles: {
          prod: {
            apiUrl: 'https://queue.example.com/',
            token: 'stored-token',
          },
        },
      },
      {
        json: false,
        quiet: false,
        token: 'override-token',
      },
    );

    expect(runtime).toEqual({
      profile: 'prod',
      apiUrl: 'https://queue.example.com',
      wsUrl: 'wss://queue.example.com',
      token: 'override-token',
    });
  });
});
