import { AgenticHarnessError } from "./adapter";
import {
  ALL_AGENTIC_ADAPTER_IDS,
  DEFAULT_AGENTIC_ADAPTER_IDS,
} from "./registry";

export interface AgenticCliOptions {
  adapterIds: string[];
  taskIds: string[] | null;
  lifecycles: ("cold" | "warm")[];
  agent: "fixture" | "local-model";
  timeoutMs: number;
  write: boolean;
  help: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const csv = (value: string, label: string): string[] => {
  const items = value.split(",").map((item) => item.trim());
  if (
    items.length === 0 ||
    items.some((item) => !item) ||
    new Set(items).size !== items.length
  )
    throw new AgenticHarnessError(
      "invalid_cli_option",
      `${label} must be a nonempty unique CSV list`
    );
  return items;
};

export const parseAgenticCliOptions = (
  argv: readonly string[]
): AgenticCliOptions => {
  const values = new Map<string, string>();
  let write = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--write" || argument === "--help") {
      if (argument === "--write") {
        if (write)
          throw new AgenticHarnessError(
            "invalid_cli_option",
            "Duplicate --write"
          );
        write = true;
      } else {
        if (help)
          throw new AgenticHarnessError(
            "invalid_cli_option",
            "Duplicate --help"
          );
        help = true;
      }
      continue;
    }
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    if (
      ![
        "--adapter",
        "--task",
        "--lifecycle",
        "--agent",
        "--timeout-ms",
      ].includes(flag)
    )
      throw new AgenticHarnessError(
        "invalid_cli_option",
        `Unknown option: ${flag}`
      );
    if (values.has(flag))
      throw new AgenticHarnessError(
        "invalid_cli_option",
        `Duplicate option: ${flag}`
      );
    const value =
      separator >= 0 ? argument.slice(separator + 1) : argv[(index += 1)];
    if (!value || value.startsWith("--"))
      throw new AgenticHarnessError(
        "invalid_cli_option",
        `${flag} requires a value`
      );
    values.set(flag, value);
  }
  const adapterIds = values.has("--adapter")
    ? csv(values.get("--adapter") as string, "--adapter")
    : [...DEFAULT_AGENTIC_ADAPTER_IDS];
  if (
    adapterIds.some(
      (adapter) => !ALL_AGENTIC_ADAPTER_IDS.includes(adapter as never)
    )
  )
    throw new AgenticHarnessError(
      "invalid_cli_option",
      "--adapter contains an unknown adapter"
    );
  const lifecycleValues = values.has("--lifecycle")
    ? csv(values.get("--lifecycle") as string, "--lifecycle")
    : ["cold", "warm"];
  if (lifecycleValues.some((value) => value !== "cold" && value !== "warm"))
    throw new AgenticHarnessError(
      "invalid_cli_option",
      "--lifecycle must be cold,warm"
    );
  const agent = values.get("--agent") ?? "fixture";
  if (agent !== "fixture" && agent !== "local-model")
    throw new AgenticHarnessError(
      "invalid_cli_option",
      "--agent must be fixture or local-model"
    );
  const timeoutMs = Number(values.get("--timeout-ms") ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new AgenticHarnessError(
      "invalid_cli_option",
      "--timeout-ms must be a positive integer"
    );
  return {
    adapterIds,
    taskIds: values.has("--task")
      ? csv(values.get("--task") as string, "--task")
      : null,
    lifecycles: (["cold", "warm"] as const).filter((value) =>
      lifecycleValues.includes(value)
    ),
    agent,
    timeoutMs,
    write,
    help,
  };
};

export const AGENTIC_CLI_HELP = `Usage: bun run eval:agentic -- [options]

Options:
  --adapter <csv>       gno-mcp,lexical,capsule (qmd is opt-in)
  --task <csv>          task IDs; defaults to all 24 fixtures
  --lifecycle <csv>     cold,warm (default: both)
  --agent <id>          fixture (default) or local-model
  --timeout-ms <n>      per lifecycle operation timeout
  --write               write only a complete authoritative/optional lane
  --help                show this help
`;
