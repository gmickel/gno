import { describe, expect, test } from "bun:test";

import { validateDoctorExit } from "../../scripts/docs-doctor-contract";

describe("documentation doctor exit validation", () => {
  test("accepts exit 2 when a non-activation doctor check errors", () => {
    const result = {
      healthy: false,
      activation: { healthy: true },
      checks: [
        { name: "retrieval-activation", status: "ok" },
        { name: "sqlite-fts5", status: "error" },
      ],
    };

    expect(validateDoctorExit(2, result)).toBeNull();
    expect(validateDoctorExit(0, result)).toBe(
      "error checks expected exit 2, received 0"
    );
  });

  test("keeps warning-only doctor results exit-safe", () => {
    const result = {
      healthy: false,
      checks: [
        { name: "retrieval-activation", status: "ok" },
        { name: "connector-activation", status: "warn" },
      ],
    };

    expect(validateDoctorExit(0, result)).toBeNull();
    expect(validateDoctorExit(2, result)).toBe(
      "error checks expected exit 0, received 2"
    );
  });

  test("rejects doctor output without valid emitted checks", () => {
    expect(validateDoctorExit(0, { healthy: true })).toBe(
      "missing checks field"
    );
    expect(
      validateDoctorExit(0, {
        healthy: true,
        checks: [{ name: "config", status: "unknown" }],
      })
    ).toBe("invalid check status");
  });
});
