import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CLIConfig, GlobalOptions, ProfileConfig, RuntimeConfig } from './types.js';

export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'taskqueue', 'config.json');

function defaultConfig(): CLIConfig {
  return { currentProfile: 'default', profiles: { default: {} } };
}

export function configPath(): string {
  return process.env.TASKQUEUE_CONFIG || DEFAULT_CONFIG_PATH;
}

export async function loadConfig(path = configPath()): Promise<CLIConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CLIConfig>;
    return {
      currentProfile: parsed.currentProfile || 'default',
      profiles: parsed.profiles || { default: {} },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultConfig();
    }
    throw new Error(`Unable to read config ${path}: ${(error as Error).message}`);
  }
}

export async function saveConfig(config: CLIConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function deriveWebSocketUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = url.port === '3000' ? '3400' : url.port;
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function resolveRuntimeConfig(config: CLIConfig, globals: GlobalOptions): RuntimeConfig {
  const profile = globals.profile || process.env.TASKQUEUE_PROFILE || config.currentProfile;
  const stored = config.profiles[profile] || {};
  const apiUrl = (
    globals.apiUrl ||
    process.env.TASKQUEUE_API_URL ||
    stored.apiUrl ||
    DEFAULT_API_URL
  ).replace(/\/$/, '');
  const wsUrl = (
    globals.wsUrl ||
    process.env.TASKQUEUE_WS_URL ||
    stored.wsUrl ||
    deriveWebSocketUrl(apiUrl)
  ).replace(/\/$/, '');
  const token = globals.token || process.env.TASKQUEUE_TOKEN || stored.token;
  return { profile, apiUrl, wsUrl, ...(token ? { token } : {}) };
}

export function getProfile(config: CLIConfig, name: string): ProfileConfig {
  return config.profiles[name] || {};
}
