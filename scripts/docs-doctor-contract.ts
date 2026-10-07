interface DoctorCheckJson {
  /** `info` reports a state that needs no repair (doctor never fails on it). */
  status: "ok" | "info" | "warn" | "error";
}

function isDoctorCheckJson(value: unknown): value is DoctorCheckJson {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const status = (value as { status?: unknown }).status;
  return (
    status === "ok" ||
    status === "info" ||
    status === "warn" ||
    status === "error"
  );
}

export function validateDoctorExit(
  code: number,
  result: unknown
): string | null {
  if (code !== 0 && code !== 2) {
    return `unexpected exit ${code}`;
  }
  if (typeof result !== "object" || result === null) {
    return "invalid result";
  }

  const doctorResult = result as { checks?: unknown; healthy?: unknown };
  if (typeof doctorResult.healthy !== "boolean") {
    return "missing healthy field";
  }
  if (!Array.isArray(doctorResult.checks)) {
    return "missing checks field";
  }
  if (!doctorResult.checks.every(isDoctorCheckJson)) {
    return "invalid check status";
  }

  const expectedCode = doctorResult.checks.some(
    ({ status }) => status === "error"
  )
    ? 2
    : 0;
  if (code !== expectedCode) {
    return `error checks expected exit ${expectedCode}, received ${code}`;
  }

  return null;
}
