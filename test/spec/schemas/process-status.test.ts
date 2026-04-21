import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("process-status schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("process-status");
  });

  describe("valid inputs", () => {
    test("validates running serve process", () => {
      const status = {
        running: true,
        pid: 12_345,
        port: 3000,
        cmd: "serve",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 600,
        pid_file: "/Users/u/Library/Application Support/gno/serve.pid",
        log_file: "/Users/u/Library/Application Support/gno/serve.log",
        log_size_bytes: 4096,
      };
      expect(assertValid(status, schema)).toBe(true);
    });

    test("validates running daemon process", () => {
      const status = {
        running: true,
        pid: 54_321,
        port: null,
        cmd: "daemon",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 120,
        pid_file: "/home/u/.local/share/gno/daemon.pid",
        log_file: "/home/u/.local/share/gno/daemon.log",
        log_size_bytes: 0,
      };
      expect(assertValid(status, schema)).toBe(true);
    });

    test("validates not-running state (no pid-file)", () => {
      const status = {
        running: false,
        pid: null,
        port: null,
        cmd: "serve",
        version: null,
        started_at: null,
        uptime_seconds: null,
        pid_file: "/Users/u/Library/Application Support/gno/serve.pid",
        log_file: "/Users/u/Library/Application Support/gno/serve.log",
        log_size_bytes: null,
      };
      expect(assertValid(status, schema)).toBe(true);
    });

    test("validates stale pid-file (process gone)", () => {
      const status = {
        running: false,
        pid: 99_999,
        port: null,
        cmd: "daemon",
        version: "1.1.0",
        started_at: "2026-04-21T10:00:00Z",
        uptime_seconds: null,
        pid_file: "/home/u/.local/share/gno/daemon.pid",
        log_file: "/home/u/.local/share/gno/daemon.log",
        log_size_bytes: 2048,
      };
      expect(assertValid(status, schema)).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    test("rejects missing running field", () => {
      const status = {
        pid: null,
        port: null,
        cmd: "serve",
        version: null,
        started_at: null,
        uptime_seconds: null,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: null,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects invalid cmd value", () => {
      const status = {
        running: false,
        pid: null,
        port: null,
        cmd: "mcp",
        version: null,
        started_at: null,
        uptime_seconds: null,
        pid_file: "/tmp/mcp.pid",
        log_file: "/tmp/mcp.log",
        log_size_bytes: null,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects negative pid", () => {
      const status = {
        running: true,
        pid: -1,
        port: 3000,
        cmd: "serve",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 10,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects out-of-range port", () => {
      const status = {
        running: true,
        pid: 1234,
        port: 70_000,
        cmd: "serve",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 10,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects non-ISO started_at", () => {
      const status = {
        running: true,
        pid: 1234,
        port: 3000,
        cmd: "serve",
        version: "1.1.0",
        started_at: "yesterday at noon",
        uptime_seconds: 10,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects missing pid_file path", () => {
      const status = {
        running: false,
        pid: null,
        port: null,
        cmd: "serve",
        version: null,
        started_at: null,
        uptime_seconds: null,
        log_file: "/tmp/serve.log",
        log_size_bytes: null,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects negative uptime_seconds", () => {
      const status = {
        running: true,
        pid: 1234,
        port: 3000,
        cmd: "serve",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: -5,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects daemon with numeric port (cmd↔port invariant)", () => {
      const status = {
        running: true,
        pid: 1234,
        port: 8080,
        cmd: "daemon",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 10,
        pid_file: "/tmp/daemon.pid",
        log_file: "/tmp/daemon.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects running:true with null pid (running invariant)", () => {
      const status = {
        running: true,
        pid: null,
        port: 3000,
        cmd: "serve",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 10,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects running:true with null uptime_seconds (running invariant)", () => {
      const status = {
        running: true,
        pid: 1234,
        port: 3000,
        cmd: "serve",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: null,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects running:true with null version (running invariant)", () => {
      const status = {
        running: true,
        pid: 1234,
        port: 3000,
        cmd: "serve",
        version: null,
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 10,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects live serve with null port (serve liveness invariant)", () => {
      const status = {
        running: true,
        pid: 1234,
        port: null,
        cmd: "serve",
        version: "1.1.0",
        started_at: "2026-04-21T19:30:00Z",
        uptime_seconds: 10,
        pid_file: "/tmp/serve.pid",
        log_file: "/tmp/serve.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });

    test("rejects running:false with numeric uptime_seconds (stale invariant)", () => {
      const status = {
        running: false,
        pid: 99_999,
        port: null,
        cmd: "daemon",
        version: "1.1.0",
        started_at: "2026-04-21T10:00:00Z",
        uptime_seconds: 3600,
        pid_file: "/tmp/daemon.pid",
        log_file: "/tmp/daemon.log",
        log_size_bytes: 0,
      };
      expect(assertInvalid(status, schema)).toBe(true);
    });
  });
});
