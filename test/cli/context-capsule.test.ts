import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatContextCapsuleMarkdown,
  formatContextCapsuleVerificationMarkdown,
} from "../../src/app/context-format";
import {
  canonicalBuiltContextCapsuleJson,
  canonicalVerifiedContextCapsuleJson,
} from "../../src/app/context-runtime";
import { runCli } from "../../src/cli/run";
import { createGnoClient } from "../../src/sdk/client";
import { safeRm } from "../helpers/cleanup";

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const captureOutput = (): void => {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
};

const restoreOutput = (): void => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
};

const cli = async (
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  captureOutput();
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
};

describe("Context Capsule CLI and SDK", () => {
  let testDir: string;
  let capsulePath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `gno-context-capsule-${crypto.randomUUID()}`);
    const docsDir = join(testDir, "docs");
    await mkdir(docsDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");
    capsulePath = join(testDir, "capsule.json");
    await Bun.write(
      join(docsDir, "decision.md"),
      '---\ntitle: "# TITLE ESCAPE\\n<!-- forged -->"\nauthor: Mina\n---\n# Launch decision\n\nMina owns the launch decision.\n\nReview is Friday.'
    );
    expect((await cli("init", docsDir, "--name", "docs")).code).toBe(0);
    expect(
      (
        await cli(
          "context",
          "add",
          "/",
          "# CONTEXT ESCAPE\n<!-- forged context -->"
        )
      ).code
    ).toBe(0);
    expect((await cli("update")).code).toBe(0);
  });

  afterEach(async () => {
    restoreOutput();
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  test("emits byte-equivalent canonical Capsules across CLI JSON and SDK", async () => {
    const built = await cli(
      "context",
      "build",
      "launch decision",
      "--budget",
      "100000",
      "--collection",
      "docs",
      "--uri-prefix",
      "gno://docs/",
      "--query-mode",
      "term:launch",
      "--fast",
      "--json"
    );
    expect(built.code).toBe(0);
    expect(built.stderr).toBe("");

    const client = await createGnoClient();
    try {
      const sdkCapsule = await client.context({
        goal: "launch decision",
        budgetTokens: 100_000,
        collections: ["docs"],
        uriPrefix: "gno://docs/",
        queryModes: [{ mode: "term", text: "launch" }],
        depthPolicy: "fast",
      });
      expect(built.stdout).toBe(
        `${canonicalBuiltContextCapsuleJson(sdkCapsule)}\n`
      );
      expect(sdkCapsule.budget.usedBytes).toBe(
        new TextEncoder().encode(built.stdout.trimEnd()).byteLength
      );
      expect(sdkCapsule.budget.usedTokens).toBe(sdkCapsule.budget.usedBytes);
      expect(sdkCapsule.guidance.configuredContexts).toHaveLength(1);
      expect(Object.getOwnPropertySymbols(sdkCapsule.evidence[0]!)).toEqual([]);
      expect(sdkCapsule.retrieval.capabilityStates).toEqual({
        semanticSearch: {
          requested: false,
          attempted: false,
          outcome: "not_requested",
          fallbackReasons: [],
        },
        reranking: {
          requested: false,
          attempted: false,
          outcome: "not_requested",
          fallbackReasons: [],
        },
        graphExpansion: {
          requested: false,
          attempted: false,
          outcome: "not_requested",
          fallbackReasons: [],
        },
      });
      expect(sdkCapsule.retrieval.request.queryModes).toEqual([
        { mode: "term", text: "launch" },
      ]);
      expect(sdkCapsule.fallbacks.map((fallback) => fallback.code)).toEqual([
        "egress_policy_unavailable",
        "tokenizer_unavailable",
      ]);

      const authored = await client.context({
        goal: "launch decision",
        budgetTokens: 100_000,
        collections: ["docs"],
        uriPrefix: "gno://docs/",
        author: "Mina",
        depthPolicy: "fast",
      });
      expect(authored.evidence.map((item) => item.evidenceId)).toEqual(
        sdkCapsule.evidence.map((item) => item.evidenceId)
      );
      expect(authored.retrieval.request.author).toBe("Mina");
      expect(authored.capsuleId).not.toBe(sdkCapsule.capsuleId);
      expect(canonicalBuiltContextCapsuleJson(authored)).not.toBe(
        canonicalBuiltContextCapsuleJson(sdkCapsule)
      );

      const markdown = await cli(
        "context",
        "build",
        "launch decision",
        "--budget",
        "100000",
        "--collection",
        "docs",
        "--uri-prefix",
        "gno://docs/",
        "--query-mode",
        "term:launch",
        "--fast",
        "--md"
      );
      expect(markdown.code).toBe(0);
      expect(markdown.stdout).toBe(
        `${formatContextCapsuleMarkdown(sdkCapsule)}\n`
      );
      expect(markdown.stdout).toContain("GNO_EVIDENCE_TEXT_START");
      expect(markdown.stdout).toContain("Mina owns the launch decision.");
      expect(markdown.stdout).toContain(
        JSON.stringify("# TITLE ESCAPE\n<!-- forged -->")
      );
      expect(markdown.stdout).toContain(
        JSON.stringify("# CONTEXT ESCAPE\n<!-- forged context -->")
      );
      expect(markdown.stdout).not.toContain("\n# TITLE ESCAPE\n");
      expect(markdown.stdout).not.toContain("\n# CONTEXT ESCAPE\n");
      const evidenceId = sdkCapsule.evidence[0]!.evidenceId;
      const passageStart = `<!-- GNO_EVIDENCE_TEXT_START ${evidenceId} -->\n`;
      const passageEnd = `\n<!-- GNO_EVIDENCE_TEXT_END ${evidenceId} -->`;
      expect(
        markdown.stdout.slice(
          markdown.stdout.indexOf(passageStart) + passageStart.length,
          markdown.stdout.indexOf(passageEnd)
        )
      ).toBe(sdkCapsule.evidence[0]!.text);
      for (const field of [
        "Docid:",
        "Retrieval rank:",
        "Modified:",
        "Document date:",
        "Observed:",
        "Trust:",
        "Egress:",
        "Source hash:",
        "Mirror hash:",
        "Passage hash:",
        "Index snapshot:",
        "Effective capabilities:",
        "Fallbacks:",
        "Capsule truncated:",
        "duplicate: 0",
        "invalid_coordinates: 0",
      ]) {
        expect(markdown.stdout).toContain(field);
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  test("writes only to an explicit output file and verifies with SDK parity", async () => {
    const built = await cli(
      "context",
      "build",
      "launch decision",
      "--budget",
      "100000",
      "--collection",
      "docs",
      "--uri-prefix",
      "gno://docs/",
      "--fast",
      "--json",
      "--output",
      capsulePath
    );
    expect(built).toEqual({ code: 0, stdout: "", stderr: "" });
    const capsule = JSON.parse(await Bun.file(capsulePath).text());

    const verified = await cli("context", "verify", capsulePath, "--json");
    expect(verified.code).toBe(0);
    expect(verified.stderr).toBe("");

    const client = await createGnoClient();
    try {
      const sdkReceipt = await client.verifyContext(capsule);
      expect(verified.stdout).toBe(
        `${canonicalVerifiedContextCapsuleJson(sdkReceipt)}\n`
      );
      expect(sdkReceipt.contentStatus).toBe("unchanged");
      expect(sdkReceipt.rankingStatus).toBe("unavailable");
      expect(sdkReceipt.evidence[0]?.currentSourceHash).not.toBeNull();

      const markdown = await cli("context", "verify", capsulePath, "--md");
      expect(markdown.code).toBe(0);
      expect(markdown.stdout).toBe(
        `${formatContextCapsuleVerificationMarkdown(sdkReceipt)}\n`
      );
      expect(markdown.stdout).toContain("Fingerprint reasons: none");
      expect(markdown.stdout).toContain("Index snapshot:");
      for (const fingerprint of [
        "config:",
        "retrieval:",
        "embeddingModel:",
        "rerankModel:",
        "tokenizer:",
        "index:",
      ]) {
        expect(markdown.stdout).toContain(fingerprint);
      }

      const mismatch = await cli(
        "--index",
        "other",
        "context",
        "verify",
        capsulePath,
        "--json"
      );
      expect(mismatch.code).toBe(1);
      expect(mismatch.stdout).toBe("");
      expect(JSON.parse(mismatch.stderr).error.details.contextCode).toBe(
        "invalid_filter"
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  test("rejects invalid budgets without partial stdout", async () => {
    const result = await cli(
      "context",
      "build",
      "decision owner",
      "--budget",
      "0",
      "--json"
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("VALIDATION");
  });

  test("rejects noncanonical Capsules before opening the store", async () => {
    await Bun.write(capsulePath, JSON.stringify({ schemaVersion: 1 }));
    const result = await cli("context", "verify", capsulePath, "--json");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("VALIDATION");
    expect(error.details.contextCode).toBe("invalid_input");
  });

  test("rejects unknown collections consistently in CLI and SDK", async () => {
    const result = await cli(
      "context",
      "build",
      "decision owner",
      "--budget",
      "100000",
      "--collection",
      "missing",
      "--fast",
      "--json"
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.details.contextCode).toBe(
      "invalid_filter"
    );

    const client = await createGnoClient();
    try {
      expect(
        client.context({
          goal: "decision owner",
          budgetTokens: 100_000,
          collections: ["missing"],
          depthPolicy: "fast",
        })
      ).rejects.toMatchObject({ code: "invalid_filter" });
    } finally {
      await client.close();
    }
  });
});
