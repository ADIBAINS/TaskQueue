import { readFile } from 'node:fs/promises';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJSONValue(
  inline?: string,
  file?: string,
  fallback: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (inline && file) {
    throw new Error('Use either --payload or --payload-file, not both');
  }

  let source: string | undefined;
  if (inline) {
    source = inline;
  } else if (file === '-') {
    source = await readStdin();
  } else if (file) {
    source = await readFile(file, 'utf8');
  }

  if (source === undefined) return fallback;

  try {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('JSON value must be an object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON: ${(error as Error).message}`);
  }
}

export function parseJSONObject(value: string | undefined, optionName: string): unknown {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON for --${optionName}: ${(error as Error).message}`);
  }
}
