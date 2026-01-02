#!/usr/bin/env bun
/**
 * MCP Write Tools Smoke Test
 *
 * Tests all MCP write operations and security features.
 * Run: bun scripts/mcp-write-smoke-test.ts
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];
let mcpProcess: ReturnType<typeof spawn> | null = null;
let requestId = 0;
let tempDir: string;
let testCollectionPath: string;

// Colors for output
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function log(msg: string) {
  console.log(msg);
}

function record(
  name: string,
  passed: boolean,
  error?: string,
  details?: string
) {
  results.push({ name, passed, error, details });
  const status = passed ? green("PASS") : red("FAIL");
  log(
    `  ${status} ${name}${error ? ` - ${red(error)}` : ""}${details ? ` ${dim(details)}` : ""}`
  );
}

async function sendRequest(method: string, params?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!mcpProcess?.stdin || !mcpProcess?.stdout) {
      reject(new Error("MCP process not running"));
      return;
    }

    const id = ++requestId;
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params || {},
    });

    let buffer = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to ${method}`));
    }, 30000);

    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id === id) {
            clearTimeout(timeout);
            mcpProcess?.stdout?.off("data", onData);
            if (response.error) {
              resolve({ error: response.error });
            } else {
              resolve(response.result);
            }
            return;
          }
        } catch {
          // Not valid JSON yet, continue buffering
        }
      }
    };

    mcpProcess.stdout.on("data", onData);
    mcpProcess.stdin.write(request + "\n");
  });
}

async function startMcp(enableWrite: boolean): Promise<void> {
  const args = ["src/index.ts", "mcp"];
  if (enableWrite) args.push("--enable-write");

  mcpProcess = spawn("bun", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  // Initialize MCP
  const initResult = await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0" },
  });

  if (!initResult?.serverInfo) {
    throw new Error("Failed to initialize MCP server");
  }

  await sendRequest("notifications/initialized", {});
}

async function stopMcp(): Promise<void> {
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
  }
}

async function callTool(name: string, args: object): Promise<any> {
  const result = await sendRequest("tools/call", { name, arguments: args });
  if (result?.structuredContent) {
    return result.structuredContent;
  }
  if (result?.content?.[0]?.text) {
    const text = result.content[0].text as string;
    const match = text.match(/Error:\s*([A-Z_]+):\s*(.*)$/);
    if (result?.isError && match) {
      return { error: match[1], message: match[2] };
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

async function getToolsList(): Promise<string[]> {
  const result = await sendRequest("tools/list", {});
  return result?.tools?.map((t: any) => t.name) || [];
}

// ============ TEST SUITES ============

async function testReadOnlyMode() {
  log("\n## Read-Only Mode (no --enable-write)\n");

  await startMcp(false);

  try {
    const tools = await getToolsList();

    // Should have read tools
    const readTools = [
      "gno_search",
      "gno_vsearch",
      "gno_query",
      "gno_get",
      "gno_multi_get",
      "gno_status",
    ];
    for (const tool of readTools) {
      record(
        `Has read tool: ${tool}`,
        tools.includes(tool),
        undefined,
        `[${tools.length} tools total]`
      );
    }

    // Should NOT have write tools
    const writeTools = [
      "gno_capture",
      "gno_add_collection",
      "gno_sync",
      "gno_remove_collection",
    ];
    for (const tool of writeTools) {
      record(
        `No write tool: ${tool}`,
        !tools.includes(tool),
        tools.includes(tool)
          ? "Write tool exposed in read-only mode!"
          : undefined
      );
    }

    // Job tools should be available (read-only)
    const jobTools = ["gno_job_status", "gno_list_jobs"];
    for (const tool of jobTools) {
      record(`Has job tool: ${tool}`, tools.includes(tool));
    }
  } finally {
    await stopMcp();
  }
}

async function testWriteEnabledMode() {
  log("\n## Write-Enabled Mode (--enable-write)\n");

  await startMcp(true);

  try {
    const tools = await getToolsList();

    // Should have ALL tools
    const allTools = [
      "gno_search",
      "gno_vsearch",
      "gno_query",
      "gno_get",
      "gno_multi_get",
      "gno_status",
      "gno_capture",
      "gno_add_collection",
      "gno_sync",
      "gno_remove_collection",
      "gno_job_status",
      "gno_list_jobs",
    ];

    for (const tool of allTools) {
      record(
        `Has tool: ${tool}`,
        tools.includes(tool),
        !tools.includes(tool) ? "Missing!" : undefined
      );
    }
  } finally {
    await stopMcp();
  }
}

async function testCollectionRootValidation() {
  log("\n## Collection Root Validation (dangerous paths)\n");

  await startMcp(true);

  try {
    const dangerousPaths = [
      { path: "/", desc: "root filesystem" },
      { path: process.env.HOME!, desc: "home dir alone" },
      { path: "/etc", desc: "/etc" },
      { path: "/usr", desc: "/usr" },
      { path: join(process.env.HOME!, ".ssh"), desc: "~/.ssh" },
      { path: join(process.env.HOME!, ".gnupg"), desc: "~/.gnupg" },
      { path: join(process.env.HOME!, ".config"), desc: "~/.config" },
    ];

    for (const { path, desc } of dangerousPaths) {
      const result = await callTool("gno_add_collection", { path });
      const rejected = result?.error || result?.code === "INVALID_PATH";
      record(
        `Rejects ${desc}`,
        rejected,
        !rejected ? `Should reject dangerous root: ${path}` : undefined
      );
    }

    // Valid path should work (or at least not be rejected for being dangerous)
    const validPath = testCollectionPath;
    const result = await callTool("gno_add_collection", { path: validPath });
    const notDangerousError = !result?.code?.includes("INVALID_PATH");
    record(
      `Accepts valid path`,
      notDangerousError,
      result?.code === "INVALID_PATH"
        ? "Wrongly rejected valid path"
        : undefined,
      validPath
    );
  } finally {
    await stopMcp();
  }
}

async function testCapture() {
  log("\n## gno_capture (create document)\n");

  await startMcp(true);

  try {
    // First add the test collection
    const addResult = await callTool("gno_add_collection", {
      path: testCollectionPath,
      name: "smoke-test",
    });

    // Wait for job if async
    if (addResult?.jobId) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Test basic capture
    const captureResult = await callTool("gno_capture", {
      collection: "smoke-test",
      content: "# Test Note\n\nThis is a smoke test.",
      title: "Smoke Test Note",
    });

    record(
      "Creates document",
      captureResult?.docid || captureResult?.uri,
      captureResult?.error || captureResult?.code,
      captureResult?.uri
    );

    // Test overwrite=false conflict
    const conflictResult = await callTool("gno_capture", {
      collection: "smoke-test",
      content: "# Duplicate",
      title: "Smoke Test Note",
      overwrite: false,
    });

    record(
      "Rejects duplicate (overwrite=false)",
      conflictResult?.code === "CONFLICT" || conflictResult?.error,
      !conflictResult?.code && !conflictResult?.error
        ? "Should have returned CONFLICT"
        : undefined
    );

    // Test overwrite=true
    const overwriteResult = await callTool("gno_capture", {
      collection: "smoke-test",
      content: "# Overwritten",
      title: "Smoke Test Note",
      overwrite: true,
    });

    record(
      "Overwrites with overwrite=true",
      overwriteResult?.docid || overwriteResult?.overwritten,
      overwriteResult?.error || overwriteResult?.code
    );

    // Test path traversal rejection
    const traversalResult = await callTool("gno_capture", {
      collection: "smoke-test",
      content: "# Evil",
      path: "../../../etc/passwd",
    });

    record(
      "Rejects path traversal",
      traversalResult?.code === "INVALID_PATH" || traversalResult?.error,
      !traversalResult?.code && !traversalResult?.error
        ? "Should reject path traversal"
        : undefined
    );

    // Test sensitive subpath rejection
    const sshResult = await callTool("gno_capture", {
      collection: "smoke-test",
      content: "# Evil",
      path: ".ssh/authorized_keys",
    });

    record(
      "Rejects sensitive subpath (.ssh)",
      sshResult?.code === "INVALID_PATH" || sshResult?.error,
      !sshResult?.code && !sshResult?.error
        ? "Should reject .ssh subpath"
        : undefined
    );

    // Test invalid collection
    const invalidCollResult = await callTool("gno_capture", {
      collection: "nonexistent-collection-xyz",
      content: "# Test",
    });

    record(
      "Rejects invalid collection",
      invalidCollResult?.code === "NOT_FOUND" || invalidCollResult?.error,
      !invalidCollResult?.code && !invalidCollResult?.error
        ? "Should return NOT_FOUND"
        : undefined
    );
  } finally {
    await stopMcp();
  }
}

async function testSync() {
  log("\n## gno_sync (reindex)\n");

  await startMcp(true);

  try {
    // Sync specific collection
    const syncResult = await callTool("gno_sync", {
      collection: "smoke-test",
    });

    record(
      "Syncs collection",
      syncResult?.jobId || syncResult?.status === "started",
      syncResult?.error || syncResult?.code,
      syncResult?.jobId ? `jobId: ${syncResult.jobId}` : undefined
    );

    // Check options in response
    record(
      "Response includes options",
      syncResult?.options !== undefined,
      !syncResult?.options
        ? "Missing options object for observability"
        : undefined,
      syncResult?.options ? JSON.stringify(syncResult.options) : undefined
    );

    // Test invalid collection
    const invalidResult = await callTool("gno_sync", {
      collection: "nonexistent-xyz",
    });

    record(
      "Rejects invalid collection",
      invalidResult?.code === "NOT_FOUND" || invalidResult?.error,
      !invalidResult?.code && !invalidResult?.error
        ? "Should return NOT_FOUND"
        : undefined
    );
  } finally {
    await stopMcp();
  }
}

async function testJobManagement() {
  log("\n## Job Management\n");

  await startMcp(true);

  try {
    // Start a sync job
    const syncResult = await callTool("gno_sync", { collection: "smoke-test" });
    const jobId = syncResult?.jobId;

    if (jobId) {
      // Check job status
      const statusResult = await callTool("gno_job_status", { jobId });

      record(
        "gno_job_status returns status",
        statusResult?.status &&
          ["running", "completed", "failed"].includes(statusResult.status),
        statusResult?.error || statusResult?.code,
        `status: ${statusResult?.status}`
      );

      record(
        "Job status includes serverInstanceId",
        statusResult?.serverInstanceId !== undefined,
        !statusResult?.serverInstanceId
          ? "Missing serverInstanceId for restart detection"
          : undefined
      );
    } else {
      record("gno_job_status", false, "No jobId from sync to test with");
    }

    // List jobs
    const listResult = await callTool("gno_list_jobs", { limit: 10 });

    record(
      "gno_list_jobs returns structure",
      listResult?.active !== undefined && listResult?.recent !== undefined,
      listResult?.error || listResult?.code,
      `active: ${listResult?.active?.length || 0}, recent: ${listResult?.recent?.length || 0}`
    );

    // Test invalid job ID
    const invalidJobResult = await callTool("gno_job_status", {
      jobId: "invalid-job-id-xyz",
    });

    record(
      "Rejects invalid jobId",
      invalidJobResult?.code === "NOT_FOUND" || invalidJobResult?.error,
      !invalidJobResult?.code && !invalidJobResult?.error
        ? "Should return NOT_FOUND"
        : undefined
    );
  } finally {
    await stopMcp();
  }
}

async function testRemoveCollection() {
  log("\n## gno_remove_collection\n");

  await startMcp(true);

  try {
    // Remove the test collection
    const removeResult = await callTool("gno_remove_collection", {
      collection: "smoke-test",
    });

    record(
      "Removes collection",
      removeResult?.removed === true || removeResult?.configUpdated,
      removeResult?.error || removeResult?.code
    );

    record(
      "Response notes data retained",
      removeResult?.indexedDataRetained === true || removeResult?.note,
      !removeResult?.indexedDataRetained && !removeResult?.note
        ? "Should indicate data is retained"
        : undefined
    );

    // Test removing non-existent collection
    const invalidResult = await callTool("gno_remove_collection", {
      collection: "nonexistent-xyz",
    });

    record(
      "Rejects non-existent collection",
      invalidResult?.code === "NOT_FOUND" || invalidResult?.error,
      !invalidResult?.code && !invalidResult?.error
        ? "Should return NOT_FOUND"
        : undefined
    );
  } finally {
    await stopMcp();
  }
}

async function testEnvVar() {
  log("\n## Environment Variable (GNO_MCP_ENABLE_WRITE)\n");

  // Start without flag but with env var
  const args = ["src/index.ts", "mcp"];
  mcpProcess = spawn("bun", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    env: { ...process.env, GNO_MCP_ENABLE_WRITE: "1" },
  });

  try {
    await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0" },
    });
    await sendRequest("notifications/initialized", {});

    const tools = await getToolsList();
    const hasWriteTools = tools.includes("gno_capture");

    record(
      "GNO_MCP_ENABLE_WRITE=1 enables write tools",
      hasWriteTools,
      !hasWriteTools ? "Env var should enable write tools" : undefined,
      `[${tools.length} tools]`
    );
  } finally {
    await stopMcp();
  }
}

// ============ MAIN ============

async function main() {
  console.log("# MCP Write Tools Smoke Test\n");
  console.log(`Started: ${new Date().toISOString()}`);

  // Create temp directory for test collection
  tempDir = await mkdtemp(join(tmpdir(), "gno-mcp-test-"));
  testCollectionPath = join(tempDir, "test-collection");
  await mkdir(testCollectionPath, { recursive: true });
  log(`Test directory: ${dim(tempDir)}`);

  try {
    await testReadOnlyMode();
    await testWriteEnabledMode();
    await testEnvVar();
    await testCollectionRootValidation();
    await testCapture();
    await testSync();
    await testJobManagement();
    await testRemoveCollection();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(red(`\nFatal error: ${message}`));
  } finally {
    await stopMcp();

    // Cleanup temp dir
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {}
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("# Summary\n");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`${green("Passed")}: ${passed}/${total}`);
  console.log(`${red("Failed")}: ${failed}/${total}`);

  if (failed > 0) {
    console.log("\n## Failed Tests:\n");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ${red("FAIL")} ${r.name}`);
      if (r.error) console.log(`       ${dim(r.error)}`);
    }
  }

  console.log(`\nFinished: ${new Date().toISOString()}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
