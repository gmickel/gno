import { describe, expect, test } from "bun:test";

import { createProgram } from "../../src/cli/program";
import { runCli } from "../../src/cli/run";

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function captureOutput() {
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
  console.log = (...args: unknown[]) => {
    stdoutData += `${args.join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderrData += `${args.join(" ")}\n`;
  };
}

function restoreOutput() {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

describe("ask query-mode CLI", () => {
  test("ask command exposes query-mode option", () => {
    const program = createProgram();
    const askCommand = program.commands.find(
      (command) => command.name() === "ask"
    );

    expect(askCommand).toBeDefined();
    expect(
      askCommand?.options.some((option) => option.long === "--query-mode")
    ).toBe(true);
  });

  test("rejects duplicate hyde query-mode flags", async () => {
    const { code } = await cli(
      "ask",
      "performance",
      "--query-mode",
      "hyde:first",
      "--query-mode",
      "hyde:second",
      "--no-answer",
      "--json"
    );

    expect(code).toBe(1);
  });
});
