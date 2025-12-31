/**
 * Commander program definition.
 * Wires all CLI commands with lazy imports for fast --help.
 *
 * @module src/cli/program
 */

import { Command } from 'commander';
import {
  CLI_NAME,
  DOCS_URL,
  ISSUES_URL,
  PRODUCT_NAME,
  VERSION,
} from '../app/constants';
import { setColorsEnabled } from './colors';
import {
  applyGlobalOptions,
  type GlobalOptions,
  parseGlobalOptions,
} from './context';
import { CliError } from './errors';
import {
  assertFormatSupported,
  CMD,
  getDefaultLimit,
  parseOptionalFloat,
  parsePositiveInt,
} from './options';

// ─────────────────────────────────────────────────────────────────────────────
// Global State (set by preAction hook)
// ─────────────────────────────────────────────────────────────────────────────

// Using object wrapper to allow mutation while satisfying linter
const globalState: { current: GlobalOptions | null } = { current: null };

/**
 * Get resolved global options. Must be called after command parsing.
 * Throws if called before preAction hook runs.
 */
export function getGlobals(): GlobalOptions {
  if (!globalState.current) {
    throw new Error('Global options not resolved - called before preAction?');
  }
  return globalState.current;
}

/**
 * Reset global state (for testing).
 * Resets both option state and color state to avoid test pollution.
 */
export function resetGlobals(): void {
  globalState.current = null;
  // Reset colors to default (true) - will be set by applyGlobalOptions on next run
  setColorsEnabled(true);
}

/**
 * Select output format with explicit precedence.
 * Precedence: local non-json format > local --json > global --json > terminal
 */
function getFormat(
  cmdOpts: Record<string, unknown>
): 'terminal' | 'json' | 'files' | 'csv' | 'md' | 'xml' {
  const globals = getGlobals();

  const local = {
    json: Boolean(cmdOpts.json),
    files: Boolean(cmdOpts.files),
    csv: Boolean(cmdOpts.csv),
    md: Boolean(cmdOpts.md),
    xml: Boolean(cmdOpts.xml),
  };

  // Count local format flags
  const localFormats = Object.entries(local).filter(([_, v]) => v);
  if (localFormats.length > 1) {
    throw new CliError(
      'VALIDATION',
      `Conflicting output formats: ${localFormats.map(([k]) => k).join(', ')}. Choose one.`
    );
  }

  // Local non-json format wins (--md, --csv, --files, --xml)
  if (local.files) {
    return 'files';
  }
  if (local.csv) {
    return 'csv';
  }
  if (local.md) {
    return 'md';
  }
  if (local.xml) {
    return 'xml';
  }

  // Local --json wins over global
  if (local.json) {
    return 'json';
  }

  // Global --json as fallback
  if (globals.json) {
    return 'json';
  }

  return 'terminal';
}

// ─────────────────────────────────────────────────────────────────────────────
// Program Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name(CLI_NAME)
    .description(`${PRODUCT_NAME} - Local Knowledge Index and Retrieval`)
    .version(VERSION, '-V, --version', 'show version')
    .exitOverride() // Prevent Commander from calling process.exit()
    .showSuggestionAfterError(true)
    .showHelpAfterError('(Use --help for available options)');

  // Global flags - resolved via preAction hook
  program
    .option('--index <name>', 'index name', 'default')
    .option('--config <path>', 'config file path')
    .option('--no-color', 'disable colors')
    .option('--verbose', 'verbose logging')
    .option('--yes', 'non-interactive mode')
    .option('-q, --quiet', 'suppress non-essential output')
    .option('--json', 'JSON output (for errors and supported commands)');

  // Resolve globals ONCE before any command runs (ensures consistency)
  program.hook('preAction', (thisCommand) => {
    const rootOpts = thisCommand.optsWithGlobals();
    const globals = parseGlobalOptions(rootOpts);
    applyGlobalOptions(globals);
    globalState.current = globals;
  });

  // Wire command groups
  wireSearchCommands(program);
  wireOnboardingCommands(program);
  wireManagementCommands(program);
  wireRetrievalCommands(program);
  wireMcpCommand(program);
  wireSkillCommands(program);

  // Add docs/support links to help footer
  program.addHelpText(
    'after',
    `
Documentation: ${DOCS_URL}
Report issues: ${ISSUES_URL}`
  );

  return program;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search Commands (search, vsearch, query, ask)
// ─────────────────────────────────────────────────────────────────────────────

function wireSearchCommands(program: Command): void {
  // search - BM25 keyword search
  program
    .command('search <query>')
    .description('BM25 keyword search')
    .option('-n, --limit <num>', 'max results')
    .option('--min-score <num>', 'minimum score threshold')
    .option('-c, --collection <name>', 'filter by collection')
    .option('--lang <code>', 'language filter/hint (BCP-47)')
    .option('--full', 'include full content')
    .option('--line-numbers', 'include line numbers in output')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .option('--csv', 'CSV output')
    .option('--xml', 'XML output')
    .option('--files', 'file paths only')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.search, format);

      // Validate empty query
      if (!queryText.trim()) {
        throw new CliError('VALIDATION', 'Query cannot be empty');
      }

      // Validate minScore range
      const minScore = parseOptionalFloat('min-score', cmdOpts.minScore);
      if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
        throw new CliError('VALIDATION', '--min-score must be between 0 and 1');
      }

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      const { search, formatSearch } = await import('./commands/search');
      const result = await search(queryText, {
        limit,
        minScore,
        collection: cmdOpts.collection as string | undefined,
        lang: cmdOpts.lang as string | undefined,
        full: Boolean(cmdOpts.full),
        lineNumbers: Boolean(cmdOpts.lineNumbers),
        json: format === 'json',
        md: format === 'md',
        csv: format === 'csv',
        xml: format === 'xml',
        files: format === 'files',
      });

      // Check success before printing - stdout is for successful outputs only
      if (!result.success) {
        // Map validation errors to exit code 1
        throw new CliError(
          result.isValidation ? 'VALIDATION' : 'RUNTIME',
          result.error
        );
      }
      process.stdout.write(
        `${formatSearch(result, {
          json: format === 'json',
          md: format === 'md',
          csv: format === 'csv',
          xml: format === 'xml',
          files: format === 'files',
          full: Boolean(cmdOpts.full),
          lineNumbers: Boolean(cmdOpts.lineNumbers),
        })}\n`
      );
    });

  // vsearch - Vector similarity search
  program
    .command('vsearch <query>')
    .description('Vector similarity search')
    .option('-n, --limit <num>', 'max results')
    .option('--min-score <num>', 'minimum score threshold')
    .option('-c, --collection <name>', 'filter by collection')
    .option('--lang <code>', 'language filter/hint (BCP-47)')
    .option('--full', 'include full content')
    .option('--line-numbers', 'include line numbers in output')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .option('--csv', 'CSV output')
    .option('--xml', 'XML output')
    .option('--files', 'file paths only')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.vsearch, format);

      // Validate empty query
      if (!queryText.trim()) {
        throw new CliError('VALIDATION', 'Query cannot be empty');
      }

      // Validate minScore range
      const minScore = parseOptionalFloat('min-score', cmdOpts.minScore);
      if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
        throw new CliError('VALIDATION', '--min-score must be between 0 and 1');
      }

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      const { vsearch, formatVsearch } = await import('./commands/vsearch');
      const result = await vsearch(queryText, {
        limit,
        minScore,
        collection: cmdOpts.collection as string | undefined,
        lang: cmdOpts.lang as string | undefined,
        full: Boolean(cmdOpts.full),
        lineNumbers: Boolean(cmdOpts.lineNumbers),
        json: format === 'json',
        md: format === 'md',
        csv: format === 'csv',
        xml: format === 'xml',
        files: format === 'files',
      });

      if (!result.success) {
        throw new CliError('RUNTIME', result.error);
      }
      process.stdout.write(
        `${formatVsearch(result, {
          json: format === 'json',
          md: format === 'md',
          csv: format === 'csv',
          xml: format === 'xml',
          files: format === 'files',
          full: Boolean(cmdOpts.full),
          lineNumbers: Boolean(cmdOpts.lineNumbers),
        })}\n`
      );
    });

  // query - Hybrid search with expansion and reranking
  program
    .command('query <query>')
    .description('Hybrid search with expansion and reranking')
    .option('-n, --limit <num>', 'max results')
    .option('--min-score <num>', 'minimum score threshold')
    .option('-c, --collection <name>', 'filter by collection')
    .option('--lang <code>', 'language hint (BCP-47)')
    .option('--full', 'include full content')
    .option('--line-numbers', 'include line numbers in output')
    .option('--no-expand', 'disable query expansion')
    .option('--no-rerank', 'disable reranking')
    .option('--explain', 'include scoring explanation')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .option('--csv', 'CSV output')
    .option('--xml', 'XML output')
    .option('--files', 'file paths only')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.query, format);

      // Validate empty query
      if (!queryText.trim()) {
        throw new CliError('VALIDATION', 'Query cannot be empty');
      }

      // Validate minScore range
      const minScore = parseOptionalFloat('min-score', cmdOpts.minScore);
      if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
        throw new CliError('VALIDATION', '--min-score must be between 0 and 1');
      }

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      const { query, formatQuery } = await import('./commands/query');
      const result = await query(queryText, {
        limit,
        minScore,
        collection: cmdOpts.collection as string | undefined,
        lang: cmdOpts.lang as string | undefined,
        full: Boolean(cmdOpts.full),
        lineNumbers: Boolean(cmdOpts.lineNumbers),
        noExpand: cmdOpts.expand === false,
        noRerank: cmdOpts.rerank === false,
        explain: Boolean(cmdOpts.explain),
        json: format === 'json',
        md: format === 'md',
        csv: format === 'csv',
        xml: format === 'xml',
        files: format === 'files',
      });

      if (!result.success) {
        throw new CliError('RUNTIME', result.error);
      }
      process.stdout.write(
        `${formatQuery(result, {
          format,
          full: Boolean(cmdOpts.full),
          lineNumbers: Boolean(cmdOpts.lineNumbers),
        })}\n`
      );
    });

  // ask - Human-friendly query with grounded answer
  program
    .command('ask <query>')
    .description('Human-friendly query with grounded answer')
    .option('-n, --limit <num>', 'max source results')
    .option('-c, --collection <name>', 'filter by collection')
    .option('--lang <code>', 'language hint (BCP-47)')
    .option('--answer', 'generate short grounded answer')
    .option('--no-answer', 'force retrieval-only output')
    .option('--max-answer-tokens <num>', 'max answer tokens')
    .option('--show-sources', 'show all retrieved sources (not just cited)')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.ask, format);

      // Validate empty query
      if (!queryText.trim()) {
        throw new CliError('VALIDATION', 'Query cannot be empty');
      }

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      // Parse max-answer-tokens (optional, defaults to 512 in command impl)
      const maxAnswerTokens = cmdOpts.maxAnswerTokens
        ? parsePositiveInt('max-answer-tokens', cmdOpts.maxAnswerTokens)
        : undefined;

      const { ask, formatAsk } = await import('./commands/ask');
      const showSources = Boolean(cmdOpts.showSources);
      const result = await ask(queryText, {
        limit,
        collection: cmdOpts.collection as string | undefined,
        lang: cmdOpts.lang as string | undefined,
        // Per spec: --answer defaults to false, --no-answer forces retrieval-only
        // Commander creates separate cmdOpts.noAnswer for --no-answer flag
        answer: Boolean(cmdOpts.answer),
        noAnswer: Boolean(cmdOpts.noAnswer),
        maxAnswerTokens,
        showSources,
        json: format === 'json',
        md: format === 'md',
      });

      if (!result.success) {
        throw new CliError('RUNTIME', result.error);
      }
      process.stdout.write(
        `${formatAsk(result, { json: format === 'json', md: format === 'md', showSources })}\n`
      );
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding Commands (init, index, status, doctor)
// ─────────────────────────────────────────────────────────────────────────────

function wireOnboardingCommands(program: Command): void {
  // init - Initialize GNO
  program
    .command('init [path]')
    .description('Initialize GNO configuration')
    .option('-n, --name <name>', 'collection name')
    .option('--pattern <glob>', 'file matching pattern')
    .option('--include <exts>', 'extension allowlist (CSV)')
    .option('--exclude <patterns>', 'exclude patterns (CSV)')
    .option('--update <cmd>', 'shell command to run before indexing')
    .option('--tokenizer <type>', 'FTS tokenizer (unicode61, porter, trigram)')
    .option('--language <code>', 'language hint (BCP-47)')
    .action(
      async (path: string | undefined, cmdOpts: Record<string, unknown>) => {
        const globals = getGlobals();
        const { init } = await import('./commands/init');
        const result = await init({
          path,
          name: cmdOpts.name as string | undefined,
          pattern: cmdOpts.pattern as string | undefined,
          include: cmdOpts.include as string | undefined,
          exclude: cmdOpts.exclude as string | undefined,
          update: cmdOpts.update as string | undefined,
          tokenizer: cmdOpts.tokenizer as
            | 'unicode61'
            | 'porter'
            | 'trigram'
            | undefined,
          language: cmdOpts.language as string | undefined,
          yes: globals.yes,
        });

        if (!result.success) {
          throw new CliError('RUNTIME', result.error ?? 'Init failed');
        }

        if (result.alreadyInitialized) {
          process.stdout.write('GNO already initialized.\n');
          if (result.collectionAdded) {
            process.stdout.write(
              `Collection "${result.collectionAdded}" added.\n`
            );
          }
        } else {
          process.stdout.write('GNO initialized successfully.\n');
          process.stdout.write(`Config: ${result.configPath}\n`);
          process.stdout.write(`Database: ${result.dbPath}\n`);
          if (result.collectionAdded) {
            process.stdout.write(
              `Collection "${result.collectionAdded}" added.\n`
            );
          }
        }
      }
    );

  // index - Index collections
  program
    .command('index [collection]')
    .description('Index files from collections')
    .option('--no-embed', 'skip embedding after sync')
    .option('--git-pull', 'run git pull in git repositories')
    .option('--models-pull', 'download models if missing')
    .action(
      async (
        collection: string | undefined,
        cmdOpts: Record<string, unknown>
      ) => {
        const globals = getGlobals();
        const { index, formatIndex } = await import('./commands/index-cmd');
        const opts = {
          collection,
          noEmbed: cmdOpts.embed === false,
          gitPull: Boolean(cmdOpts.gitPull),
          modelsPull: Boolean(cmdOpts.modelsPull),
          yes: globals.yes,
          verbose: globals.verbose,
        };
        const result = await index(opts);

        if (!result.success) {
          throw new CliError('RUNTIME', result.error ?? 'Index failed');
        }
        process.stdout.write(`${formatIndex(result, opts)}\n`);
      }
    );

  // status - Show index status
  program
    .command('status')
    .description('Show index status')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.status, format);

      const { status, formatStatus } = await import('./commands/status');
      const result = await status({ json: format === 'json' });

      if (!result.success) {
        throw new CliError('RUNTIME', result.error ?? 'Status failed');
      }
      process.stdout.write(
        `${formatStatus(result, { json: format === 'json' })}\n`
      );
    });

  // doctor - Diagnose configuration issues
  program
    .command('doctor')
    .description('Diagnose configuration issues')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      const { doctor, formatDoctor } = await import('./commands/doctor');
      const result = await doctor({ json: format === 'json' });

      // Doctor always succeeds but may report issues
      process.stdout.write(
        `${formatDoctor(result, { json: format === 'json' })}\n`
      );
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval Commands (get, multi-get, ls)
// ─────────────────────────────────────────────────────────────────────────────

function wireRetrievalCommands(program: Command): void {
  // get - Retrieve document by URI or docid
  program
    .command('get <ref>')
    .description('Get document by URI or docid')
    .option(
      '--from <line>',
      'Start at line number',
      parsePositiveInt.bind(null, 'from')
    )
    .option(
      '-l, --limit <lines>',
      'Limit to N lines',
      parsePositiveInt.bind(null, 'limit')
    )
    .option('--line-numbers', 'Prefix lines with numbers')
    .option('--source', 'Include source metadata')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .action(async (ref: string, cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.get, format);
      const globals = getGlobals();

      const { get, formatGet } = await import('./commands/get');
      const result = await get(ref, {
        configPath: globals.config,
        from: cmdOpts.from as number | undefined,
        limit: cmdOpts.limit as number | undefined,
        lineNumbers: Boolean(cmdOpts.lineNumbers),
        source: Boolean(cmdOpts.source),
        json: format === 'json',
        md: format === 'md',
      });

      if (!result.success) {
        throw new CliError(
          result.isValidation ? 'VALIDATION' : 'RUNTIME',
          result.error
        );
      }

      process.stdout.write(
        `${formatGet(result, {
          lineNumbers: Boolean(cmdOpts.lineNumbers),
          json: format === 'json',
          md: format === 'md',
        })}\n`
      );
    });

  // multi-get - Retrieve multiple documents
  program
    .command('multi-get <refs...>')
    .description('Get multiple documents by URI or docid')
    .option(
      '--max-bytes <n>',
      'Max bytes per document',
      parsePositiveInt.bind(null, 'max-bytes')
    )
    .option('--line-numbers', 'Include line numbers')
    .option('--json', 'JSON output')
    .option('--files', 'File protocol output')
    .option('--md', 'Markdown output')
    .action(async (refs: string[], cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.multiGet, format);
      const globals = getGlobals();

      const { multiGet, formatMultiGet } = await import('./commands/multi-get');
      const result = await multiGet(refs, {
        configPath: globals.config,
        maxBytes: cmdOpts.maxBytes as number | undefined,
        lineNumbers: Boolean(cmdOpts.lineNumbers),
        json: format === 'json',
        files: format === 'files',
        md: format === 'md',
      });

      if (!result.success) {
        throw new CliError(
          result.isValidation ? 'VALIDATION' : 'RUNTIME',
          result.error
        );
      }

      process.stdout.write(
        `${formatMultiGet(result, {
          lineNumbers: Boolean(cmdOpts.lineNumbers),
          json: format === 'json',
          files: format === 'files',
          md: format === 'md',
        })}\n`
      );
    });

  // ls - List indexed documents
  program
    .command('ls [scope]')
    .description('List indexed documents')
    .option(
      '-n, --limit <num>',
      'Max results',
      parsePositiveInt.bind(null, 'limit')
    )
    .option(
      '--offset <num>',
      'Skip first N results',
      parsePositiveInt.bind(null, 'offset')
    )
    .option('--json', 'JSON output')
    .option('--files', 'File protocol output')
    .option('--md', 'Markdown output')
    .action(
      async (scope: string | undefined, cmdOpts: Record<string, unknown>) => {
        const format = getFormat(cmdOpts);
        assertFormatSupported(CMD.ls, format);
        const globals = getGlobals();

        const { ls, formatLs } = await import('./commands/ls');
        const result = await ls(scope, {
          configPath: globals.config,
          limit: cmdOpts.limit as number | undefined,
          offset: cmdOpts.offset as number | undefined,
          json: format === 'json',
          files: format === 'files',
          md: format === 'md',
        });

        if (!result.success) {
          throw new CliError(
            result.isValidation ? 'VALIDATION' : 'RUNTIME',
            result.error
          );
        }

        process.stdout.write(
          `${formatLs(result, {
            json: format === 'json',
            files: format === 'files',
            md: format === 'md',
          })}\n`
        );
      }
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Commands
// ─────────────────────────────────────────────────────────────────────────────

function wireMcpCommand(program: Command): void {
  // mcp - Start MCP server (stdio transport) or manage MCP configuration
  // CRITICAL: helpOption(false) on server command prevents --help from writing
  // to stdout which would corrupt the JSON-RPC stream
  const mcpCmd = program
    .command('mcp')
    .description('MCP server and configuration');

  // Default action: start MCP server
  mcpCmd
    .command('serve', { isDefault: true })
    .description('Start MCP server (stdio transport)')
    .helpOption(false)
    .action(async () => {
      const { mcpCommand } = await import('./commands/mcp.js');
      const globalOpts = program.opts();
      const globals = parseGlobalOptions(globalOpts);
      await mcpCommand(globals);
    });

  // install - Install gno MCP server to client configs
  mcpCmd
    .command('install')
    .description('Install gno as MCP server in client configuration')
    .option(
      '-t, --target <target>',
      'target client (claude-desktop, cursor, zed, windsurf, opencode, amp, lmstudio, librechat, claude-code, codex)',
      'claude-desktop'
    )
    .option(
      '-s, --scope <scope>',
      'scope (user, project) - project only for claude-code/codex/cursor/opencode',
      'user'
    )
    .option('-f, --force', 'overwrite existing configuration')
    .option('--dry-run', 'show what would be done without making changes')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const target = cmdOpts.target as string;
      const scope = cmdOpts.scope as string;

      // Import MCP_TARGETS for validation
      const { MCP_TARGETS } = await import('./commands/mcp/paths.js');

      // Validate target
      if (!(MCP_TARGETS as string[]).includes(target)) {
        throw new CliError(
          'VALIDATION',
          `Invalid target: ${target}. Must be one of: ${MCP_TARGETS.join(', ')}.`
        );
      }
      // Validate scope
      if (!['user', 'project'].includes(scope)) {
        throw new CliError(
          'VALIDATION',
          `Invalid scope: ${scope}. Must be 'user' or 'project'.`
        );
      }

      const { installMcp } = await import('./commands/mcp/install.js');
      await installMcp({
        target: target as NonNullable<
          Parameters<typeof installMcp>[0]
        >['target'],
        scope: scope as 'user' | 'project',
        force: Boolean(cmdOpts.force),
        dryRun: Boolean(cmdOpts.dryRun),
        // Pass undefined if not set, so global --json can take effect
        json: cmdOpts.json === true ? true : undefined,
      });
    });

  // uninstall - Remove gno MCP server from client configs
  mcpCmd
    .command('uninstall')
    .description('Remove gno MCP server from client configuration')
    .option(
      '-t, --target <target>',
      'target client (claude-desktop, cursor, zed, windsurf, opencode, amp, lmstudio, librechat, claude-code, codex)',
      'claude-desktop'
    )
    .option('-s, --scope <scope>', 'scope (user, project)', 'user')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const target = cmdOpts.target as string;
      const scope = cmdOpts.scope as string;

      // Import MCP_TARGETS for validation
      const { MCP_TARGETS } = await import('./commands/mcp/paths.js');

      // Validate target
      if (!(MCP_TARGETS as string[]).includes(target)) {
        throw new CliError(
          'VALIDATION',
          `Invalid target: ${target}. Must be one of: ${MCP_TARGETS.join(', ')}.`
        );
      }
      // Validate scope
      if (!['user', 'project'].includes(scope)) {
        throw new CliError(
          'VALIDATION',
          `Invalid scope: ${scope}. Must be 'user' or 'project'.`
        );
      }

      const { uninstallMcp } = await import('./commands/mcp/uninstall.js');
      await uninstallMcp({
        target: target as NonNullable<
          Parameters<typeof uninstallMcp>[0]
        >['target'],
        scope: scope as 'user' | 'project',
        // Pass undefined if not set, so global --json can take effect
        json: cmdOpts.json === true ? true : undefined,
      });
    });

  // status - Show MCP installation status
  mcpCmd
    .command('status')
    .description('Show MCP server installation status')
    .option(
      '-t, --target <target>',
      'filter by target (claude-desktop, cursor, zed, windsurf, opencode, amp, lmstudio, librechat, claude-code, codex, all)',
      'all'
    )
    .option(
      '-s, --scope <scope>',
      'filter by scope (user, project, all)',
      'all'
    )
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const target = cmdOpts.target as string;
      const scope = cmdOpts.scope as string;

      // Import MCP_TARGETS for validation
      const { MCP_TARGETS, TARGETS_WITH_PROJECT_SCOPE } = await import(
        './commands/mcp/paths.js'
      );

      // Validate target
      if (target !== 'all' && !(MCP_TARGETS as string[]).includes(target)) {
        throw new CliError(
          'VALIDATION',
          `Invalid target: ${target}. Must be one of: ${MCP_TARGETS.join(', ')}, all.`
        );
      }
      // Validate scope
      if (!['user', 'project', 'all'].includes(scope)) {
        throw new CliError(
          'VALIDATION',
          `Invalid scope: ${scope}. Must be 'user', 'project', or 'all'.`
        );
      }
      // Validate target/scope combination
      if (
        target !== 'all' &&
        scope === 'project' &&
        !(TARGETS_WITH_PROJECT_SCOPE as string[]).includes(target)
      ) {
        throw new CliError(
          'VALIDATION',
          `${target} does not support project scope.`
        );
      }

      const { statusMcp } = await import('./commands/mcp/status.js');
      await statusMcp({
        target: target as NonNullable<
          Parameters<typeof statusMcp>[0]
        >['target'],
        scope: scope as 'user' | 'project' | 'all',
        // Pass undefined if not set, so global --json can take effect
        json: cmdOpts.json === true ? true : undefined,
      });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Management Commands (collection, context, models, update, embed, cleanup)
// ─────────────────────────────────────────────────────────────────────────────

function wireManagementCommands(program: Command): void {
  // collection subcommands
  const collectionCmd = program
    .command('collection')
    .description('Manage collections');

  collectionCmd
    .command('add <path>')
    .description('Add a collection')
    .requiredOption('-n, --name <name>', 'collection name')
    .option('--pattern <glob>', 'file matching pattern')
    .option('--include <exts>', 'extension allowlist (CSV)')
    .option('--exclude <patterns>', 'exclude patterns (CSV)')
    .option('--update <cmd>', 'shell command to run before indexing')
    .action(async (path: string, cmdOpts: Record<string, unknown>) => {
      const { collectionAdd } = await import('./commands/collection');
      await collectionAdd(path, {
        name: cmdOpts.name as string,
        pattern: cmdOpts.pattern as string | undefined,
        include: cmdOpts.include as string | undefined,
        exclude: cmdOpts.exclude as string | undefined,
        update: cmdOpts.update as string | undefined,
      });
    });

  collectionCmd
    .command('list')
    .description('List collections')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.collectionList, format);

      const { collectionList } = await import('./commands/collection');
      await collectionList({
        json: format === 'json',
        md: format === 'md',
      });
    });

  collectionCmd
    .command('remove <name>')
    .description('Remove a collection')
    .action(async (name: string) => {
      const { collectionRemove } = await import('./commands/collection');
      await collectionRemove(name);
    });

  collectionCmd
    .command('rename <old> <new>')
    .description('Rename a collection')
    .action(async (oldName: string, newName: string) => {
      const { collectionRename } = await import('./commands/collection');
      await collectionRename(oldName, newName);
    });

  // context subcommands
  const contextCmd = program
    .command('context')
    .description('Manage context items');

  contextCmd
    .command('add <scope> <text>')
    .description('Add context metadata for a scope')
    .action(async (scope: string, text: string) => {
      const { contextAdd } = await import('./commands/context');
      const exitCode = await contextAdd(scope, text);
      if (exitCode !== 0) {
        throw new CliError('RUNTIME', 'Failed to add context');
      }
    });

  contextCmd
    .command('list')
    .description('List context items')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.contextList, format);

      const { contextList } = await import('./commands/context');
      await contextList(format as 'terminal' | 'json' | 'md');
    });

  contextCmd
    .command('check')
    .description('Check context configuration')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.contextCheck, format);

      const { contextCheck } = await import('./commands/context');
      await contextCheck(format as 'terminal' | 'json' | 'md');
    });

  contextCmd
    .command('rm <uri>')
    .description('Remove context item')
    .action(async (uri: string) => {
      const { contextRm } = await import('./commands/context');
      await contextRm(uri);
    });

  // models subcommands
  const modelsCmd = program.command('models').description('Manage LLM models');

  modelsCmd
    .command('list')
    .description('List available models')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      assertFormatSupported(CMD.modelsList, format);

      const { modelsList, formatModelsList } = await import(
        './commands/models'
      );
      const result = await modelsList({ json: format === 'json' });
      process.stdout.write(
        `${formatModelsList(result, { json: format === 'json' })}\n`
      );
    });

  modelsCmd
    .command('use')
    .description('Switch active model preset')
    .argument('<preset>', 'preset ID (slim, balanced, quality)')
    .action(async (preset: string) => {
      const globals = getGlobals();
      const { modelsUse, formatModelsUse } = await import(
        './commands/models/use'
      );
      const result = await modelsUse(preset, { configPath: globals.config });
      if (!result.success) {
        throw new CliError('VALIDATION', result.error);
      }
      process.stdout.write(`${formatModelsUse(result)}\n`);
    });

  modelsCmd
    .command('pull')
    .description('Download models')
    .option('--all', 'download all configured models')
    .option('--embed', 'download embedding model')
    .option('--rerank', 'download reranker model')
    .option('--gen', 'download generation model')
    .option('--force', 'force re-download')
    .option('--no-progress', 'disable download progress')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const globals = getGlobals();
      const { modelsPull, formatModelsPull, createProgressRenderer } =
        await import('./commands/models');

      // Merge global quiet/json with local --no-progress
      const showProgress =
        (process.stderr.isTTY ?? false) &&
        !globals.quiet &&
        !globals.json &&
        cmdOpts.progress !== false;

      const result = await modelsPull({
        all: Boolean(cmdOpts.all),
        embed: Boolean(cmdOpts.embed),
        rerank: Boolean(cmdOpts.rerank),
        gen: Boolean(cmdOpts.gen),
        force: Boolean(cmdOpts.force),
        onProgress: showProgress ? createProgressRenderer() : undefined,
      });

      // For models pull, print result first, then check for failures
      // This allows partial success output before throwing
      process.stdout.write(`${formatModelsPull(result)}\n`);
      if (result.failed > 0) {
        throw new CliError('RUNTIME', `${result.failed} model(s) failed`);
      }
    });

  modelsCmd
    .command('clear')
    .description('Clear model cache')
    .action(async () => {
      const globals = getGlobals();
      const { modelsClear, formatModelsClear } = await import(
        './commands/models'
      );
      const result = await modelsClear({ yes: globals.yes });
      process.stdout.write(`${formatModelsClear(result)}\n`);
    });

  modelsCmd
    .command('path')
    .description('Show model cache path')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const format = getFormat(cmdOpts);
      const { modelsPath, formatModelsPath } = await import(
        './commands/models'
      );
      const result = modelsPath();
      process.stdout.write(
        `${formatModelsPath(result, { json: format === 'json' })}\n`
      );
    });

  // update - Sync files from disk
  program
    .command('update')
    .description('Sync files from disk into the index')
    .option('--git-pull', 'run git pull in git repositories')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const globals = getGlobals();
      const { update, formatUpdate } = await import('./commands/update');
      const opts = {
        gitPull: Boolean(cmdOpts.gitPull),
        verbose: globals.verbose,
      };
      const result = await update(opts);

      if (!result.success) {
        throw new CliError('RUNTIME', result.error ?? 'Update failed');
      }
      process.stdout.write(`${formatUpdate(result, opts)}\n`);
    });

  // embed - Generate embeddings
  program
    .command('embed')
    .description('Generate embeddings for indexed documents')
    .option('--model <uri>', 'embedding model URI')
    .option('--batch-size <num>', 'batch size', '32')
    .option('--force', 'regenerate all embeddings')
    .option('--dry-run', 'show what would be done')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const globals = getGlobals();
      const format = getFormat(cmdOpts);

      const { embed, formatEmbed } = await import('./commands/embed');
      const opts = {
        model: cmdOpts.model as string | undefined,
        batchSize: parsePositiveInt('batch-size', cmdOpts.batchSize),
        force: Boolean(cmdOpts.force),
        dryRun: Boolean(cmdOpts.dryRun),
        yes: globals.yes,
        json: format === 'json',
      };
      const result = await embed(opts);

      if (!result.success) {
        throw new CliError('RUNTIME', result.error ?? 'Embed failed');
      }
      process.stdout.write(`${formatEmbed(result, opts)}\n`);
    });

  // cleanup - Clean stale data
  program
    .command('cleanup')
    .description('Clean orphaned data from index')
    .action(async () => {
      const { cleanup, formatCleanup } = await import('./commands/cleanup');
      const result = await cleanup();

      if (!result.success) {
        throw new CliError('RUNTIME', result.error ?? 'Cleanup failed');
      }
      process.stdout.write(`${formatCleanup(result)}\n`);
    });

  // reset - Reset GNO to fresh state
  program
    .command('reset')
    .description('Delete all GNO data and start fresh')
    .option('--confirm', 'confirm destructive operation')
    .option('--keep-config', 'preserve config file')
    .option('--keep-cache', 'preserve model cache')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const { reset, formatReset } = await import('./commands/reset');
      const globals = getGlobals();
      const result = await reset({
        // Accept either --confirm or global --yes
        confirm: Boolean(cmdOpts.confirm) || globals.yes,
        keepConfig: Boolean(cmdOpts.keepConfig),
        keepCache: Boolean(cmdOpts.keepCache),
      });
      process.stdout.write(`${formatReset(result)}\n`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Commands (install, uninstall, show, paths)
// ─────────────────────────────────────────────────────────────────────────────

function wireSkillCommands(program: Command): void {
  const skillCmd = program
    .command('skill')
    .description('Manage GNO agent skill');

  skillCmd
    .command('install')
    .description('Install GNO skill to Claude Code or Codex')
    .option(
      '-s, --scope <scope>',
      'installation scope (project, user)',
      'project'
    )
    .option(
      '-t, --target <target>',
      'target agent (claude, codex, all)',
      'claude'
    )
    .option('-f, --force', 'overwrite existing installation')
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const scope = cmdOpts.scope as string;
      const target = cmdOpts.target as string;

      // Validate scope
      if (!['project', 'user'].includes(scope)) {
        throw new CliError(
          'VALIDATION',
          `Invalid scope: ${scope}. Must be 'project' or 'user'.`
        );
      }
      // Validate target
      if (!['claude', 'codex', 'all'].includes(target)) {
        throw new CliError(
          'VALIDATION',
          `Invalid target: ${target}. Must be 'claude', 'codex', or 'all'.`
        );
      }

      const { installSkill } = await import('./commands/skill/install.js');
      await installSkill({
        scope: scope as 'project' | 'user',
        target: target as 'claude' | 'codex' | 'all',
        force: Boolean(cmdOpts.force),
        json: Boolean(cmdOpts.json),
      });
    });

  skillCmd
    .command('uninstall')
    .description('Uninstall GNO skill')
    .option(
      '-s, --scope <scope>',
      'installation scope (project, user)',
      'project'
    )
    .option(
      '-t, --target <target>',
      'target agent (claude, codex, all)',
      'claude'
    )
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const scope = cmdOpts.scope as string;
      const target = cmdOpts.target as string;

      // Validate scope
      if (!['project', 'user'].includes(scope)) {
        throw new CliError(
          'VALIDATION',
          `Invalid scope: ${scope}. Must be 'project' or 'user'.`
        );
      }
      // Validate target
      if (!['claude', 'codex', 'all'].includes(target)) {
        throw new CliError(
          'VALIDATION',
          `Invalid target: ${target}. Must be 'claude', 'codex', or 'all'.`
        );
      }

      const { uninstallSkill } = await import('./commands/skill/uninstall.js');
      await uninstallSkill({
        scope: scope as 'project' | 'user',
        target: target as 'claude' | 'codex' | 'all',
        json: Boolean(cmdOpts.json),
      });
    });

  skillCmd
    .command('show')
    .description('Preview skill files without installing')
    .option('--file <name>', 'specific file to show')
    .option('--all', 'show all skill files')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const { showSkill } = await import('./commands/skill/show.js');
      await showSkill({
        file: cmdOpts.file as string | undefined,
        all: Boolean(cmdOpts.all),
      });
    });

  skillCmd
    .command('paths')
    .description('Show resolved skill installation paths')
    .option(
      '-s, --scope <scope>',
      'filter by scope (project, user, all)',
      'all'
    )
    .option(
      '-t, --target <target>',
      'filter by target (claude, codex, all)',
      'all'
    )
    .option('--json', 'JSON output')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const scope = cmdOpts.scope as string;
      const target = cmdOpts.target as string;

      // Validate scope
      if (!['project', 'user', 'all'].includes(scope)) {
        throw new CliError(
          'VALIDATION',
          `Invalid scope: ${scope}. Must be 'project', 'user', or 'all'.`
        );
      }
      // Validate target
      if (!['claude', 'codex', 'all'].includes(target)) {
        throw new CliError(
          'VALIDATION',
          `Invalid target: ${target}. Must be 'claude', 'codex', or 'all'.`
        );
      }

      const { showPaths } = await import('./commands/skill/paths-cmd.js');
      await showPaths({
        scope: scope as 'project' | 'user' | 'all',
        target: target as 'claude' | 'codex' | 'all',
        json: Boolean(cmdOpts.json),
      });
    });
}
