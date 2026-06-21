import type { GlobalOptions } from './types.js';

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function printResult(value: unknown, globals: GlobalOptions): void {
  if (globals.quiet) return;
  if (globals.json || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(value, null, globals.json ? 2 : 0)}\n`);
    return;
  }

  if (Array.isArray(value)) {
    printTable(value as Array<Record<string, unknown>>);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      process.stdout.write(`${key.padEnd(18)} ${displayValue(item)}\n`);
    }
  } else {
    process.stdout.write(`${displayValue(value)}\n`);
  }
}

export function printTable(rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) {
    process.stdout.write('No results.\n');
    return;
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const widths = columns.map((column) =>
    Math.min(48, Math.max(column.length, ...rows.map((row) => displayValue(row[column]).length))),
  );
  const line = (row: Record<string, unknown>) =>
    columns
      .map((column, index) =>
        displayValue(row[column]).slice(0, widths[index]!).padEnd(widths[index]!),
      )
      .join('  ');

  process.stdout.write(`${line(Object.fromEntries(columns.map((column) => [column, column])))}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}
