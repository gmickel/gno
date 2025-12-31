/**
 * Output format selection and validation.
 * Implements conditional defaults per spec.
 *
 * @module src/cli/options
 */

import { CliError } from './errors';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OutputFormat = 'terminal' | 'json' | 'files' | 'csv' | 'md' | 'xml';

// ─────────────────────────────────────────────────────────────────────────────
// Format Support Matrix (per spec/cli.md)
// ─────────────────────────────────────────────────────────────────────────────

// Command IDs for consistent referencing
export const CMD = {
  search: 'search',
  vsearch: 'vsearch',
  query: 'query',
  ask: 'ask',
  get: 'get',
  multiGet: 'multi-get',
  ls: 'ls',
  status: 'status',
  collectionList: 'collection.list',
  contextList: 'context.list',
  contextCheck: 'context.check',
  modelsList: 'models.list',
} as const;

export type CommandId = (typeof CMD)[keyof typeof CMD];

const FORMAT_SUPPORT: Record<CommandId, OutputFormat[]> = {
  [CMD.search]: ['terminal', 'json', 'files', 'csv', 'md', 'xml'],
  [CMD.vsearch]: ['terminal', 'json', 'files', 'csv', 'md', 'xml'],
  [CMD.query]: ['terminal', 'json', 'files', 'csv', 'md', 'xml'],
  [CMD.ask]: ['terminal', 'json', 'md'],
  [CMD.get]: ['terminal', 'json', 'md'],
  [CMD.multiGet]: ['terminal', 'json', 'files', 'md'],
  [CMD.ls]: ['terminal', 'json', 'files', 'md'],
  [CMD.status]: ['terminal', 'json'],
  [CMD.collectionList]: ['terminal', 'json', 'md'],
  [CMD.contextList]: ['terminal', 'json', 'md'],
  [CMD.contextCheck]: ['terminal', 'json', 'md'],
  [CMD.modelsList]: ['terminal', 'json'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Format Selection
// ─────────────────────────────────────────────────────────────────────────────

export interface FormatFlags {
  json?: boolean;
  files?: boolean;
  csv?: boolean;
  md?: boolean;
  xml?: boolean;
}

/**
 * Select output format from flags.
 * Throws if multiple format flags are set.
 */
export function selectOutputFormat(flags: FormatFlags): OutputFormat {
  const selected: OutputFormat[] = [];
  if (flags.json) {
    selected.push('json');
  }
  if (flags.files) {
    selected.push('files');
  }
  if (flags.csv) {
    selected.push('csv');
  }
  if (flags.md) {
    selected.push('md');
  }
  if (flags.xml) {
    selected.push('xml');
  }

  if (selected.length > 1) {
    throw new CliError(
      'VALIDATION',
      `Conflicting output formats: ${selected.join(', ')}. Choose one.`
    );
  }

  return selected[0] ?? 'terminal';
}

/**
 * Assert format is supported for command.
 */
export function assertFormatSupported(
  cmd: CommandId,
  format: OutputFormat
): void {
  const supported = FORMAT_SUPPORT[cmd];
  if (!supported.includes(format)) {
    throw new CliError(
      'VALIDATION',
      `Format --${format} is not supported by '${cmd}'. Supported: ${supported.join(', ')}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditional Defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get default limit based on format.
 * Spec: 5 for terminal, 20 for structured output.
 */
export function getDefaultLimit(format: OutputFormat): number {
  return format === 'terminal' ? 5 : 20;
}

// ─────────────────────────────────────────────────────────────────────────────
// Numeric Option Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse and validate a positive integer option.
 * Throws CliError on invalid input.
 */
export function parsePositiveInt(name: string, value: unknown): number {
  if (value === undefined || value === null) {
    throw new CliError('VALIDATION', `--${name} requires a value`);
  }
  const strValue = String(value);
  const num = Number.parseInt(strValue, 10);
  if (Number.isNaN(num)) {
    throw new CliError(
      'VALIDATION',
      `--${name} must be a number, got: ${strValue}`
    );
  }
  if (num < 1) {
    throw new CliError('VALIDATION', `--${name} must be positive, got: ${num}`);
  }
  return num;
}

/**
 * Parse optional positive integer, returning undefined if not provided.
 */
export function parseOptionalPositiveInt(
  name: string,
  value: unknown
): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  return parsePositiveInt(name, value);
}

/**
 * Parse optional float, returning undefined if not provided.
 */
export function parseOptionalFloat(
  name: string,
  value: unknown
): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  const strValue = String(value);
  const num = Number.parseFloat(strValue);
  if (Number.isNaN(num)) {
    throw new CliError(
      'VALIDATION',
      `--${name} must be a number, got: ${strValue}`
    );
  }
  return num;
}
