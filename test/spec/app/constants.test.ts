import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// node:path: join for cross-platform path normalization in tests
import { join } from 'node:path';
import {
  buildUri,
  CLI_NAME,
  DEFAULT_INDEX_NAME,
  DIR_NAME,
  DOCID_LENGTH,
  DOCID_PREFIX,
  deriveDocid,
  ENV_CACHE_DIR,
  ENV_CONFIG_DIR,
  ENV_DATA_DIR,
  getConfigPath,
  getIndexDbPath,
  getModelsCachePath,
  getPlatformPaths,
  isDocid,
  MCP_SERVER_NAME,
  MCP_TOOL_PREFIX,
  PRODUCT_NAME,
  parseUri,
  resolveDirs,
  URI_PREFIX,
  URI_SCHEME,
} from '../../../src/app/constants';

describe('constants', () => {
  describe('brand identity', () => {
    test('product name is GNO', () => {
      expect(PRODUCT_NAME).toBe('GNO');
    });

    test('CLI name is gno', () => {
      expect(CLI_NAME).toBe('gno');
    });

    test('URI scheme is gno', () => {
      expect(URI_SCHEME).toBe('gno');
    });

    test('URI prefix is gno://', () => {
      expect(URI_PREFIX).toBe('gno://');
    });
  });

  describe('MCP identity', () => {
    test('MCP server name is gno', () => {
      expect(MCP_SERVER_NAME).toBe('gno');
    });

    test('MCP tool prefix is gno', () => {
      expect(MCP_TOOL_PREFIX).toBe('gno');
    });
  });

  describe('environment variables', () => {
    test('env var names are uppercase GNO_*', () => {
      expect(ENV_CONFIG_DIR).toBe('GNO_CONFIG_DIR');
      expect(ENV_DATA_DIR).toBe('GNO_DATA_DIR');
      expect(ENV_CACHE_DIR).toBe('GNO_CACHE_DIR');
    });
  });

  describe('defaults', () => {
    test('directory name is gno', () => {
      expect(DIR_NAME).toBe('gno');
    });

    test('default index name is default', () => {
      expect(DEFAULT_INDEX_NAME).toBe('default');
    });
  });
});

describe('getPlatformPaths', () => {
  test('darwin paths use Library directories', () => {
    const paths = getPlatformPaths('darwin');
    // Check for platform-independent path components
    expect(paths.config).toContain('Library');
    expect(paths.config).toContain('gno');
    expect(paths.config).toContain('config');
    expect(paths.data).toContain('Library');
    expect(paths.data).toContain('gno');
    expect(paths.data).toContain('data');
    expect(paths.cache).toContain('Library');
    expect(paths.cache).toContain('gno');
  });

  test('linux paths use XDG-style directories', () => {
    const paths = getPlatformPaths('linux');
    expect(paths.config).toContain('gno');
    expect(paths.data).toContain('gno');
    expect(paths.cache).toContain('gno');
  });

  test('win32 paths use AppData directories', () => {
    const paths = getPlatformPaths('win32');
    expect(paths.config).toContain('gno');
    expect(paths.data).toContain('gno');
    expect(paths.cache).toContain('gno');
  });
});

describe('resolveDirs', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env[ENV_CONFIG_DIR];
    delete process.env[ENV_DATA_DIR];
    delete process.env[ENV_CACHE_DIR];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('uses platform defaults when no env vars set', () => {
    const dirs = resolveDirs('darwin');
    const platformDirs = getPlatformPaths('darwin');
    expect(dirs.config).toBe(platformDirs.config);
    expect(dirs.data).toBe(platformDirs.data);
    expect(dirs.cache).toBe(platformDirs.cache);
  });

  test('env vars override platform defaults', () => {
    process.env[ENV_CONFIG_DIR] = '/custom/config';
    process.env[ENV_DATA_DIR] = '/custom/data';
    process.env[ENV_CACHE_DIR] = '/custom/cache';

    const dirs = resolveDirs('darwin');
    expect(dirs.config).toBe('/custom/config');
    expect(dirs.data).toBe('/custom/data');
    expect(dirs.cache).toBe('/custom/cache');
  });

  test('partial env overrides work', () => {
    process.env[ENV_CONFIG_DIR] = '/custom/config';
    // data and cache not set

    const dirs = resolveDirs('darwin');
    const platformDirs = getPlatformPaths('darwin');

    expect(dirs.config).toBe('/custom/config');
    expect(dirs.data).toBe(platformDirs.data);
    expect(dirs.cache).toBe(platformDirs.cache);
  });
});

describe('getIndexDbPath', () => {
  test('uses default index name', () => {
    const dirs = { config: '/c', data: '/d', cache: '/k' };
    const path = getIndexDbPath(undefined, dirs);
    // Use platform-appropriate path separator
    expect(path).toBe(join(dirs.data, 'index-default.sqlite'));
  });

  test('uses custom index name', () => {
    const dirs = { config: '/c', data: '/d', cache: '/k' };
    const path = getIndexDbPath('work', dirs);
    expect(path).toBe(join(dirs.data, 'index-work.sqlite'));
  });
});

describe('getConfigPath', () => {
  test('returns config file path', () => {
    const dirs = { config: '/c', data: '/d', cache: '/k' };
    const path = getConfigPath(dirs);
    expect(path).toBe(join(dirs.config, 'index.yml'));
  });
});

describe('getModelsCachePath', () => {
  test('returns models cache path', () => {
    const dirs = { config: '/c', data: '/d', cache: '/k' };
    const path = getModelsCachePath(dirs);
    expect(path).toBe(join(dirs.cache, 'models'));
  });
});

describe('URI utilities', () => {
  describe('buildUri', () => {
    test('builds simple URI', () => {
      expect(buildUri('work', 'docs/readme.md')).toBe(
        'gno://work/docs/readme.md'
      );
    });

    test('encodes special characters', () => {
      expect(buildUri('work', 'docs/my file.md')).toBe(
        'gno://work/docs/my%20file.md'
      );
    });

    test('preserves slashes', () => {
      expect(buildUri('notes', 'a/b/c/d.md')).toBe('gno://notes/a/b/c/d.md');
    });
  });

  describe('parseUri', () => {
    test('parses valid URI', () => {
      const result = parseUri('gno://work/contracts/nda.docx');
      expect(result).toEqual({
        collection: 'work',
        path: 'contracts/nda.docx',
      });
    });

    test('decodes URL-encoded paths', () => {
      const result = parseUri('gno://work/my%20file.md');
      expect(result).toEqual({ collection: 'work', path: 'my file.md' });
    });

    test('handles collection-only URI', () => {
      const result = parseUri('gno://notes');
      expect(result).toEqual({ collection: 'notes', path: '' });
    });

    test('returns null for invalid URI', () => {
      expect(parseUri('file:///foo/bar')).toBeNull();
      expect(parseUri('https://example.com')).toBeNull();
      expect(parseUri('not-a-uri')).toBeNull();
    });
  });

  test('buildUri and parseUri are inverse operations', () => {
    const collection = 'work';
    const path = 'contracts/nda.docx';
    const uri = buildUri(collection, path);
    const parsed = parseUri(uri);
    expect(parsed).toEqual({ collection, path });
  });
});

describe('docid utilities', () => {
  test('DOCID_PREFIX is #', () => {
    expect(DOCID_PREFIX).toBe('#');
  });

  test('DOCID_LENGTH is 8', () => {
    expect(DOCID_LENGTH).toBe(8);
  });

  describe('deriveDocid', () => {
    test('derives docid from hash', () => {
      const hash = 'a1b2c3d4e5f6';
      expect(deriveDocid(hash)).toBe('#a1b2c3d4');
    });

    test('handles long hashes', () => {
      const hash =
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
      expect(deriveDocid(hash)).toBe('#abcdef01');
    });
  });

  describe('isDocid', () => {
    test('validates correct docids', () => {
      expect(isDocid('#a1b2c3')).toBe(true);
      expect(isDocid('#abcdef')).toBe(true);
      expect(isDocid('#ABCDEF')).toBe(true);
      expect(isDocid('#a1b2c3d4')).toBe(true); // 8 chars
    });

    test('rejects invalid docids', () => {
      expect(isDocid('a1b2c3')).toBe(false); // no prefix
      expect(isDocid('#a1b2')).toBe(false); // too short
      expect(isDocid('#a1b2c3d4e')).toBe(false); // too long
      expect(isDocid('#ghijkl')).toBe(false); // invalid hex
      expect(isDocid('')).toBe(false);
    });
  });
});
