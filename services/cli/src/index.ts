#!/usr/bin/env node

import { sign, decode } from 'jsonwebtoken';
import WebSocket from 'ws';
import { parseArgs, getBoolean, getInteger, getString } from './args.js';
import { configPath, getProfile, loadConfig, resolveRuntimeConfig, saveConfig } from './config.js';
import { completionScript } from './completion.js';
import { commandHelp, mainHelp, VERSION } from './help.js';
import { APIClient, APIError } from './http.js';
import { parseJSONObject, readJSONValue } from './input.js';
import { printResult } from './output.js';
import type { CLIConfig, GlobalOptions, ParsedArgs, RuntimeConfig } from './types.js';

type JSONObject = Record<string, unknown>;

function globalOptions(args: ParsedArgs): GlobalOptions {
  return {
    json: getBoolean(args, 'json'),
    quiet: getBoolean(args, 'quiet'),
    profile: getString(args, 'profile'),
    apiUrl: getString(args, 'api-url'),
    wsUrl: getString(args, 'ws-url'),
    token: getString(args, 'token'),
  };
}

function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function requireJobType(value: string): 'email' | 'image' | 'data' {
  if (!['email', 'image', 'data'].includes(value)) {
    throw new Error('Job type must be email, image, or data');
  }
  return value as 'email' | 'image' | 'data';
}

function client(runtime: RuntimeConfig): APIClient {
  return new APIClient(runtime.apiUrl, runtime.token);
}

async function handleConfig(
  args: ParsedArgs,
  config: CLIConfig,
  globals: GlobalOptions,
): Promise<unknown> {
  const action = requirePositional(args, 1, 'config action');
  const profileName = globals.profile || config.currentProfile;
  const profile = getProfile(config, profileName);

  if (action === 'list') {
    return {
      configPath: configPath(),
      currentProfile: config.currentProfile,
      selectedProfile: profileName,
      apiUrl: profile.apiUrl || null,
      wsUrl: profile.wsUrl || null,
      tokenConfigured: Boolean(profile.token),
    };
  }

  const key = requirePositional(args, 2, 'config key');
  if (!['api-url', 'ws-url', 'token'].includes(key)) {
    throw new Error('Config key must be api-url, ws-url, or token');
  }
  const property = key === 'api-url' ? 'apiUrl' : key === 'ws-url' ? 'wsUrl' : 'token';

  if (action === 'get') {
    const value = profile[property];
    return key === 'token' ? { tokenConfigured: Boolean(value) } : { [key]: value || null };
  }

  config.profiles[profileName] = profile;
  if (action === 'set') {
    const value = requirePositional(args, 3, 'config value');
    profile[property] = value;
    await saveConfig(config);
    return { profile: profileName, updated: key };
  }

  if (action === 'unset') {
    delete profile[property];
    await saveConfig(config);
    return { profile: profileName, removed: key };
  }

  throw new Error(`Unknown config action: ${action}`);
}

async function handleProfile(args: ParsedArgs, config: CLIConfig): Promise<unknown> {
  const action = requirePositional(args, 1, 'profile action');
  if (action === 'list') {
    return Object.keys(config.profiles)
      .sort()
      .map((name) => ({
        name,
        current: name === config.currentProfile,
        apiUrl: config.profiles[name]?.apiUrl || null,
        authenticated: Boolean(config.profiles[name]?.token),
      }));
  }

  const name = requirePositional(args, 2, 'profile name');
  if (action === 'use') {
    config.profiles[name] ||= {};
    config.currentProfile = name;
    await saveConfig(config);
    return { currentProfile: name };
  }
  if (action === 'delete') {
    if (name === 'default') throw new Error('The default profile cannot be deleted');
    if (!config.profiles[name]) throw new Error(`Profile not found: ${name}`);
    delete config.profiles[name];
    if (config.currentProfile === name) config.currentProfile = 'default';
    config.profiles.default ||= {};
    await saveConfig(config);
    return { deleted: name, currentProfile: config.currentProfile };
  }
  throw new Error(`Unknown profile action: ${action}`);
}

async function handleAuth(
  args: ParsedArgs,
  config: CLIConfig,
  globals: GlobalOptions,
): Promise<unknown> {
  const action = requirePositional(args, 1, 'auth action');
  const profileName = globals.profile || config.currentProfile;
  const profile = (config.profiles[profileName] ||= {});

  if (action === 'login') {
    const secret = getString(args, 'secret') || process.env.JWT_SECRET;
    if (!secret) throw new Error('Provide --secret or set JWT_SECRET');
    const token = sign({ client: getString(args, 'client') || 'taskqueue-cli' }, secret, {
      expiresIn: (getString(args, 'expires-in') || '24h') as never,
    });
    profile.token = token;
    await saveConfig(config);
    return { profile: profileName, authenticated: true };
  }

  if (action === 'token') {
    profile.token = requirePositional(args, 2, 'JWT token');
    await saveConfig(config);
    return { profile: profileName, authenticated: true };
  }

  if (action === 'logout') {
    delete profile.token;
    await saveConfig(config);
    return { profile: profileName, authenticated: false };
  }

  if (action === 'status') {
    if (!profile.token) return { profile: profileName, authenticated: false };
    const claims = decode(profile.token) as JSONObject | null;
    return {
      profile: profileName,
      authenticated: true,
      client: claims?.client || null,
      expiresAt: typeof claims?.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : null,
    };
  }

  throw new Error(`Unknown auth action: ${action}`);
}

async function handleJob(args: ParsedArgs, runtime: RuntimeConfig): Promise<unknown> {
  const action = requirePositional(args, 1, 'job action');
  const api = client(runtime);

  if (action === 'list') {
    const type = getString(args, 'type');
    if (type) requireJobType(type);
    const status = getString(args, 'status');
    const limit = getInteger(args, 'limit', { min: 1, max: 200 }) ?? 50;
    const query = new URLSearchParams({ limit: String(limit) });
    if (type) query.set('type', type);
    if (status) query.set('status', status.toUpperCase());
    const result = await api.request<{ jobs: JSONObject[] }>('GET', `/jobs?${query.toString()}`, {
      authenticated: true,
    });
    return result.jobs;
  }

  if (action === 'submit') {
    const type = requireJobType(requirePositional(args, 2, 'job type'));
    const payload = await readJSONValue(
      getString(args, 'payload'),
      getString(args, 'payload-file'),
    );
    const priority = getInteger(args, 'priority', { min: 1, max: 5 }) ?? 3;
    const maxRetries = getInteger(args, 'max-retries', { min: 0, max: 100 }) ?? 3;
    const body: JSONObject = { type, priority, maxRetries, payload };
    const optional = {
      idempotencyKey: getString(args, 'idempotency-key'),
      scheduledAt: getString(args, 'schedule'),
      webhookUrl: getString(args, 'webhook'),
      onSuccess: parseJSONObject(getString(args, 'on-success'), 'on-success'),
      onFailure: parseJSONObject(getString(args, 'on-failure'), 'on-failure'),
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined) body[key] = value;
    }
    return api.request<JSONObject>('POST', '/jobs', { body, authenticated: true });
  }

  const jobId = requirePositional(args, 2, 'job ID');
  if (action === 'get') {
    return api.request<JSONObject>('GET', `/jobs/${encodeURIComponent(jobId)}`);
  }
  if (action === 'cancel' || action === 'retry') {
    return api.request<JSONObject>('POST', `/jobs/${encodeURIComponent(jobId)}/${action}`, {
      authenticated: true,
    });
  }
  if (action === 'watch') {
    return watchJob(runtime, jobId, getInteger(args, 'timeout', { min: 1 }));
  }
  throw new Error(`Unknown job action: ${action}`);
}

async function watchJob(
  runtime: RuntimeConfig,
  jobId: string,
  timeoutSeconds?: number,
): Promise<unknown> {
  const current = await client(runtime).request<{ job: JSONObject }>(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}`,
  );
  if (['SUCCESS', 'FAILED', 'DEAD', 'CANCELLED'].includes(String(current.job.status))) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'job_update',
        jobId,
        previousStatus: current.job.status,
        newStatus: current.job.status,
        terminal: true,
      })}\n`,
    );
    return current.job;
  }

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'x-client-id': `taskqueue-cli-${process.pid}`,
    };
    if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
    const socket = new WebSocket(runtime.wsUrl, { headers });
    let timer: NodeJS.Timeout | undefined;

    if (timeoutSeconds) {
      timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out after ${timeoutSeconds} seconds`));
      }, timeoutSeconds * 1000);
    }

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', jobId }));
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as JSONObject;
      if (message.type === 'subscribed') return;
      process.stdout.write(`${JSON.stringify(message)}\n`);
      if (['SUCCESS', 'FAILED', 'DEAD', 'CANCELLED'].includes(String(message.newStatus))) {
        if (timer) clearTimeout(timer);
        socket.close();
        resolve(message);
      }
    });
    socket.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`WebSocket connection failed: ${error.message}`));
    });
  });
}

async function handleCron(args: ParsedArgs, runtime: RuntimeConfig): Promise<unknown> {
  const action = requirePositional(args, 1, 'cron action');
  const api = client(runtime);
  if (action === 'list') {
    const result = await api.request<{ cronJobs: JSONObject[] }>('GET', '/cron', {
      authenticated: true,
    });
    return result.cronJobs;
  }
  if (action === 'create') {
    const name = requirePositional(args, 2, 'cron name');
    const cronExpression = requirePositional(args, 3, 'cron expression');
    const jobType = requireJobType(requirePositional(args, 4, 'job type'));
    const payload = await readJSONValue(
      getString(args, 'payload'),
      getString(args, 'payload-file'),
    );
    return api.request<JSONObject>('POST', '/cron', {
      authenticated: true,
      body: {
        name,
        cronExpression,
        jobType,
        payload,
        priority: getInteger(args, 'priority', { min: 1, max: 5 }) ?? 3,
      },
    });
  }
  if (action === 'disable') {
    const id = requirePositional(args, 2, 'cron ID');
    return api.request<JSONObject>('DELETE', `/cron/${encodeURIComponent(id)}`, {
      authenticated: true,
    });
  }
  throw new Error(`Unknown cron action: ${action}`);
}

async function handleDLQ(args: ParsedArgs, runtime: RuntimeConfig): Promise<unknown> {
  const action = requirePositional(args, 1, 'DLQ action');
  const api = client(runtime);
  if (action === 'list') {
    const type = getString(args, 'type');
    if (type) requireJobType(type);
    const result = await api.request<{ entries: JSONObject[] }>(
      'GET',
      `/dlq${type ? `?type=${encodeURIComponent(type)}` : ''}`,
      { authenticated: true },
    );
    return result.entries;
  }
  if (action === 'requeue') {
    const id = requirePositional(args, 2, 'DLQ entry ID');
    return api.request<JSONObject>('POST', `/dlq/${encodeURIComponent(id)}/requeue`, {
      authenticated: true,
    });
  }
  throw new Error(`Unknown DLQ action: ${action}`);
}

async function execute(args: ParsedArgs): Promise<void> {
  const globals = globalOptions(args);
  const command = args.positionals[0];

  if (getBoolean(args, 'version') || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!command || getBoolean(args, 'help') || command === 'help') {
    process.stdout.write(command && command !== 'help' ? `${commandHelp(command)}\n` : mainHelp());
    return;
  }

  if (command === 'completion') {
    process.stdout.write(completionScript(requirePositional(args, 1, 'shell')));
    return;
  }

  const config = await loadConfig();
  const runtime = resolveRuntimeConfig(config, globals);
  let result: unknown;

  switch (command) {
    case 'config':
      result = await handleConfig(args, config, globals);
      break;
    case 'profile':
      result = await handleProfile(args, config);
      break;
    case 'auth':
      result = await handleAuth(args, config, globals);
      break;
    case 'job':
      result = await handleJob(args, runtime);
      break;
    case 'queue':
      if (requirePositional(args, 1, 'queue action') !== 'stats') {
        throw new Error('Unknown queue action');
      }
      result = (await client(runtime).request<{ queues: JSONObject[] }>('GET', '/queues/stats'))
        .queues;
      break;
    case 'cron':
      result = await handleCron(args, runtime);
      break;
    case 'dlq':
      result = await handleDLQ(args, runtime);
      break;
    case 'health':
      result = await client(runtime).request<JSONObject>('GET', '/health');
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  if (!(command === 'job' && args.positionals[1] === 'watch')) {
    printResult(result, globals);
  }
}

function exitCode(error: unknown): number {
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) return 4;
    if (error.status === 404) return 3;
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith('Missing required') ||
    message.startsWith('Unknown command') ||
    message.startsWith('Unknown ') ||
    message.startsWith('Option ') ||
    message.startsWith('Job type')
  ) {
    return 2;
  }
  return 1;
}

execute(parseArgs(process.argv.slice(2))).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskqueue: ${message}\n`);
  process.exitCode = exitCode(error);
});
