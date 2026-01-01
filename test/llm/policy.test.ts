/**
 * Tests for download policy resolution.
 * Table-driven tests for all env/flag combinations.
 */

import { describe, expect, test } from 'bun:test';
import { resolveDownloadPolicy } from '../../src/llm/policy';

describe('resolveDownloadPolicy', () => {
  // Table-driven test cases
  // Format: [description, env, flags, expected]
  const cases: [
    string,
    Record<string, string | undefined>,
    { offline?: boolean },
    { offline: boolean; allowDownload: boolean },
  ][] = [
    // Default case
    [
      'default (no env, no flags)',
      {},
      {},
      { offline: false, allowDownload: true },
    ],

    // --offline flag (highest precedence)
    [
      '--offline flag alone',
      {},
      { offline: true },
      { offline: true, allowDownload: false },
    ],
    [
      '--offline flag overrides GNO_NO_AUTO_DOWNLOAD',
      { GNO_NO_AUTO_DOWNLOAD: '1' },
      { offline: true },
      { offline: true, allowDownload: false },
    ],

    // HF_HUB_OFFLINE env var
    [
      'HF_HUB_OFFLINE=1',
      { HF_HUB_OFFLINE: '1' },
      {},
      { offline: true, allowDownload: false },
    ],
    [
      'HF_HUB_OFFLINE=true',
      { HF_HUB_OFFLINE: 'true' },
      {},
      { offline: true, allowDownload: false },
    ],
    [
      'HF_HUB_OFFLINE=yes',
      { HF_HUB_OFFLINE: 'yes' },
      {},
      { offline: true, allowDownload: false },
    ],
    [
      'HF_HUB_OFFLINE=0 (falsy)',
      { HF_HUB_OFFLINE: '0' },
      {},
      { offline: false, allowDownload: true },
    ],
    [
      'HF_HUB_OFFLINE="" (empty)',
      { HF_HUB_OFFLINE: '' },
      {},
      { offline: false, allowDownload: true },
    ],

    // GNO_OFFLINE env var
    [
      'GNO_OFFLINE=1',
      { GNO_OFFLINE: '1' },
      {},
      { offline: true, allowDownload: false },
    ],
    [
      'GNO_OFFLINE=true',
      { GNO_OFFLINE: 'true' },
      {},
      { offline: true, allowDownload: false },
    ],
    [
      'GNO_OFFLINE=0 (falsy)',
      { GNO_OFFLINE: '0' },
      {},
      { offline: false, allowDownload: true },
    ],

    // GNO_NO_AUTO_DOWNLOAD env var (lower precedence than GNO_OFFLINE)
    [
      'GNO_NO_AUTO_DOWNLOAD=1',
      { GNO_NO_AUTO_DOWNLOAD: '1' },
      {},
      { offline: false, allowDownload: false },
    ],
    [
      'GNO_NO_AUTO_DOWNLOAD=true',
      { GNO_NO_AUTO_DOWNLOAD: 'true' },
      {},
      { offline: false, allowDownload: false },
    ],
    [
      'GNO_NO_AUTO_DOWNLOAD=0 (falsy)',
      { GNO_NO_AUTO_DOWNLOAD: '0' },
      {},
      { offline: false, allowDownload: true },
    ],

    // Precedence: HF_HUB_OFFLINE > GNO_NO_AUTO_DOWNLOAD
    [
      'HF_HUB_OFFLINE=1 + GNO_NO_AUTO_DOWNLOAD=1 -> HF wins',
      { HF_HUB_OFFLINE: '1', GNO_NO_AUTO_DOWNLOAD: '1' },
      {},
      { offline: true, allowDownload: false },
    ],

    // --offline flag always wins
    [
      '--offline + HF_HUB_OFFLINE=1 -> flag wins',
      { HF_HUB_OFFLINE: '1' },
      { offline: true },
      { offline: true, allowDownload: false },
    ],

    // Flag explicitly false shouldn't activate offline
    [
      'offline: false in flags',
      {},
      { offline: false },
      { offline: false, allowDownload: true },
    ],
  ];

  for (const [description, env, flags, expected] of cases) {
    test(description, () => {
      const result = resolveDownloadPolicy(env, flags);
      expect(result).toEqual(expected);
    });
  }
});
