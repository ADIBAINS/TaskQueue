import type { OptionValue, ParsedArgs } from './types.js';

const VALUE_OPTIONS = new Set([
  'api-url',
  'client',
  'expires-in',
  'idempotency-key',
  'limit',
  'max-retries',
  'name',
  'on-failure',
  'on-success',
  'payload',
  'payload-file',
  'priority',
  'profile',
  'schedule',
  'secret',
  'status',
  'timeout',
  'token',
  'type',
  'webhook',
  'ws-url',
]);

const SHORT_ALIASES: Record<string, string> = {
  f: 'payload-file',
  h: 'help',
  j: 'json',
  p: 'priority',
  q: 'quiet',
  t: 'type',
  v: 'version',
};

function addOption(
  options: Record<string, OptionValue>,
  name: string,
  value: string | boolean,
): void {
  const existing = options[name];
  if (existing === undefined) {
    options[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    options[name] = [String(existing), String(value)];
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, OptionValue> = {};

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;

    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith('--no-')) {
      addOption(options, arg.slice(5), false);
      continue;
    }

    if (arg.startsWith('--')) {
      const [rawName, inlineValue] = arg.slice(2).split('=', 2);
      const name = rawName!;
      if (inlineValue !== undefined) {
        addOption(options, name, inlineValue);
      } else if (VALUE_OPTIONS.has(name)) {
        const next = argv[index + 1];
        if (!next || next.startsWith('-')) {
          throw new Error(`Option --${name} requires a value`);
        }
        addOption(options, name, next);
        index++;
      } else {
        addOption(options, name, true);
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const flags = arg.slice(1);
      if (flags.length > 1 && !SHORT_ALIASES[flags]) {
        for (const flag of flags) {
          addOption(options, SHORT_ALIASES[flag] || flag, true);
        }
      } else {
        const name = SHORT_ALIASES[flags] || flags;
        if (VALUE_OPTIONS.has(name)) {
          const next = argv[index + 1];
          if (!next || next.startsWith('-')) {
            throw new Error(`Option -${flags} requires a value`);
          }
          addOption(options, name, next);
          index++;
        } else {
          addOption(options, name, true);
        }
      }
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, options };
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  if (value === undefined || typeof value === 'boolean') return undefined;
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export function getBoolean(args: ParsedArgs, name: string): boolean {
  return args.options[name] === true;
}

export function getInteger(
  args: ParsedArgs,
  name: string,
  constraints: { min?: number; max?: number } = {},
): number | undefined {
  const raw = getString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Option --${name} must be an integer`);
  }
  if (constraints.min !== undefined && value < constraints.min) {
    throw new Error(`Option --${name} must be at least ${constraints.min}`);
  }
  if (constraints.max !== undefined && value > constraints.max) {
    throw new Error(`Option --${name} must be at most ${constraints.max}`);
  }
  return value;
}
