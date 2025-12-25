/**
 * Commander program definition.
 * Wires all CLI commands with lazy imports for fast --help.
 *
 * @module src/cli/program
 */

import { Command } from 'commander';
import { CLI_NAME, PRODUCT_NAME, VERSION } from '../app/constants';
import { resolveGlobalOptions } from './context';
import { CliError } from './errors';
import {
  assertFormatSupported,
  CMD,
  getDefaultLimit,
  parseOptionalFloat,
  parsePositiveInt,
  selectOutputFormat,
} from './options';

// ─────────────────────────────────────────────────────────────────────────────
// Program Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createProgram(): Command {
  const program = new Command();

  program
    .name(CLI_NAME)
    .description(`${PRODUCT_NAME} - Local Knowledge Index and Retrieval`)
    .version(VERSION, '-V, --version', 'show version')
    .exitOverride(); // Prevent Commander from calling process.exit()

  // Global flags - resolved via resolveGlobalOptions()
  program
    .option('--index <name>', 'index name', 'default')
    .option('--config <path>', 'config file path')
    .option('--no-color', 'disable colors')
    .option('--verbose', 'verbose logging')
    .option('--yes', 'non-interactive mode');

  // Wire command groups
  wireSearchCommands(program);
  wireOnboardingCommands(program);
  wireManagementCommands(program);
  wireRetrievalCommands(program);
  wireMcpCommand(program);

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
    .option('--full', 'include full content')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .option('--csv', 'CSV output')
    .option('--xml', 'XML output')
    .option('--files', 'file paths only')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      resolveGlobalOptions(program.opts()); // Validate global options
      const format = selectOutputFormat(cmdOpts);
      assertFormatSupported(CMD.search, format);

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      const { search, formatSearch } = await import('./commands/search');
      const result = await search(queryText, {
        limit,
        minScore: parseOptionalFloat('min-score', cmdOpts.minScore),
        collection: cmdOpts.collection as string | undefined,
        full: Boolean(cmdOpts.full),
        json: format === 'json',
        md: format === 'md',
        csv: format === 'csv',
        xml: format === 'xml',
        files: format === 'files',
      });

      // Check success before printing - stdout is for successful outputs only
      if (!result.success) {
        throw new CliError('RUNTIME', result.error);
      }
      process.stdout.write(
        `${formatSearch(result, { json: format === 'json' })}\n`
      );
    });

  // vsearch - Vector similarity search
  program
    .command('vsearch <query>')
    .description('Vector similarity search')
    .option('-n, --limit <num>', 'max results')
    .option('--min-score <num>', 'minimum score threshold')
    .option('-c, --collection <name>', 'filter by collection')
    .option('--full', 'include full content')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .option('--csv', 'CSV output')
    .option('--xml', 'XML output')
    .option('--files', 'file paths only')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      resolveGlobalOptions(program.opts());
      const format = selectOutputFormat(cmdOpts);
      assertFormatSupported(CMD.vsearch, format);

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      const { vsearch, formatVsearch } = await import('./commands/vsearch');
      const result = await vsearch(queryText, {
        limit,
        minScore: parseOptionalFloat('min-score', cmdOpts.minScore),
        collection: cmdOpts.collection as string | undefined,
        full: Boolean(cmdOpts.full),
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
        `${formatVsearch(result, { json: format === 'json' })}\n`
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
    .option('--no-expand', 'disable query expansion')
    .option('--no-rerank', 'disable reranking')
    .option('--explain', 'include scoring explanation')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .option('--csv', 'CSV output')
    .option('--xml', 'XML output')
    .option('--files', 'file paths only')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      resolveGlobalOptions(program.opts());
      const format = selectOutputFormat(cmdOpts);
      assertFormatSupported(CMD.query, format);

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      const { query, formatQuery } = await import('./commands/query');
      const result = await query(queryText, {
        limit,
        minScore: parseOptionalFloat('min-score', cmdOpts.minScore),
        collection: cmdOpts.collection as string | undefined,
        lang: cmdOpts.lang as string | undefined,
        full: Boolean(cmdOpts.full),
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
        `${formatQuery(result, { json: format === 'json' })}\n`
      );
    });

  // ask - Human-friendly query with grounded answer
  program
    .command('ask <query>')
    .description('Human-friendly query with grounded answer')
    .option('-n, --limit <num>', 'max source results')
    .option('-c, --collection <name>', 'filter by collection')
    .option('--lang <code>', 'language hint (BCP-47)')
    .option('--[no-]answer', 'generate grounded answer', true)
    .option('--max-tokens <num>', 'max answer tokens', '512')
    .option('--json', 'JSON output')
    .option('--md', 'Markdown output')
    .action(async (queryText: string, cmdOpts: Record<string, unknown>) => {
      resolveGlobalOptions(program.opts());
      const format = selectOutputFormat(cmdOpts);
      assertFormatSupported(CMD.ask, format);

      const limit = cmdOpts.limit
        ? parsePositiveInt('limit', cmdOpts.limit)
        : getDefaultLimit(format);

      const { ask, formatAsk } = await import('./commands/ask');
      const result = await ask(queryText, {
        limit,
        collection: cmdOpts.collection as string | undefined,
        lang: cmdOpts.lang as string | undefined,
        answer: cmdOpts.answer !== false,
        noAnswer: cmdOpts.answer === false,
        maxAnswerTokens: parsePositiveInt('max-tokens', cmdOpts.maxTokens),
        json: format === 'json',
        md: format === 'md',
      });

      if (!result.success) {
        throw new CliError('RUNTIME', result.error);
      }
      process.stdout.write(
        `${formatAsk(result, { json: format === 'json' })}\n`
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
        const globals = resolveGlobalOptions(program.opts());
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
        const globals = resolveGlobalOptions(program.opts());
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
      const format = selectOutputFormat(cmdOpts);
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
      const format = selectOutputFormat(cmdOpts);
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
    .option('--json', 'JSON output')
    .action(async (_ref: string, cmdOpts: Record<string, unknown>) => {
      const format = selectOutputFormat(cmdOpts);
      assertFormatSupported(CMD.get, format);

      // Stub - will be implemented in EPIC 9
      throw new CliError('RUNTIME', 'get command not yet implemented');
    });

  // multi-get - Retrieve multiple documents
  program
    .command('multi-get <refs...>')
    .description('Get multiple documents by URI or docid')
    .option('--json', 'JSON output')
    .action(async (_refs: string[], cmdOpts: Record<string, unknown>) => {
      const format = selectOutputFormat(cmdOpts);
      assertFormatSupported(CMD.multiGet, format);

      // Stub - will be implemented in EPIC 9
      throw new CliError('RUNTIME', 'multi-get command not yet implemented');
    });

  // ls - List indexed documents
  program
    .command('ls [collection]')
    .description('List indexed documents')
    .option('-n, --limit <num>', 'max results', '20')
    .option('--offset <num>', 'skip first N results')
    .option('--json', 'JSON output')
    .action(
      async (
        _collection: string | undefined,
        cmdOpts: Record<string, unknown>
      ) => {
        const format = selectOutputFormat(cmdOpts);
        assertFormatSupported(CMD.ls, format);

        // Stub - will be implemented in EPIC 9
        throw new CliError('RUNTIME', 'ls command not yet implemented');
      }
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Command
// ─────────────────────────────────────────────────────────────────────────────

function wireMcpCommand(program: Command): void {
  // mcp - Start MCP server (stdio transport)
  program
    .command('mcp')
    .description('Start MCP server (stdio transport)')
    .action(async () => {
      // Stub - will be implemented in EPIC 10
      throw new CliError('RUNTIME', 'mcp command not yet implemented');
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
      const format = selectOutputFormat(cmdOpts);
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
      const format = selectOutputFormat(cmdOpts);
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
      const format = selectOutputFormat(cmdOpts);
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
      const format = selectOutputFormat(cmdOpts);
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
    .command('pull')
    .description('Download models')
    .option('--all', 'download all configured models')
    .option('--embed', 'download embedding model')
    .option('--rerank', 'download reranker model')
    .option('--gen', 'download generation model')
    .option('--force', 'force re-download')
    .option('--quiet', 'quiet mode (no progress)')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const { modelsPull, formatModelsPull, createProgressRenderer } =
        await import('./commands/models');
      const result = await modelsPull({
        all: Boolean(cmdOpts.all),
        embed: Boolean(cmdOpts.embed),
        rerank: Boolean(cmdOpts.rerank),
        gen: Boolean(cmdOpts.gen),
        force: Boolean(cmdOpts.force),
        quiet: Boolean(cmdOpts.quiet),
        onProgress: cmdOpts.quiet ? undefined : createProgressRenderer(),
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
      const globals = resolveGlobalOptions(program.opts());
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
      const format = selectOutputFormat(cmdOpts);
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
      const globals = resolveGlobalOptions(program.opts());
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
      const globals = resolveGlobalOptions(program.opts());
      const format = selectOutputFormat(cmdOpts);

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
}
