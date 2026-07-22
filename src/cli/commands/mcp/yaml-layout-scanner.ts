/** Narrow, source-preserving YAML layout scanner for LibreChat's MCP map. */

import { CliError } from "../../errors.js";

export interface YamlPairSpan {
  key: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  commaBefore?: number;
  commaAfter?: number;
}

export interface YamlMapSpan {
  kind: "block" | "flow";
  start: number;
  end: number;
  indent: string;
  items: YamlPairSpan[];
}

export interface YamlTargetLayout {
  root: YamlMapSpan;
  serversPair?: YamlPairSpan;
  servers?: YamlMapSpan;
  gnoPair?: YamlPairSpan;
}

interface LineSpan {
  start: number;
  end: number;
  fullEnd: number;
  text: string;
}

const countIndent = (text: string): number => {
  const match = /^ */u.exec(text);
  return match?.[0].length ?? 0;
};

const linesOf = (content: string): LineSpan[] => {
  const lines: LineSpan[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const fullEnd = newline === -1 ? content.length : newline + 1;
    const rawEnd = newline === -1 ? content.length : newline;
    const end =
      rawEnd > start && content[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
    lines.push({ start, end, fullEnd, text: content.slice(start, end) });
    start = fullEnd;
  }
  return lines;
};

const decodeKey = (raw: string, configPath: string): string => {
  const key = raw.trim();
  if (!key || /^[?!&*]/u.test(key) || key.startsWith("!!")) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely edit complex YAML keys in ${configPath}.`
    );
  }
  if (key.startsWith('"')) {
    try {
      const decoded = JSON.parse(key) as unknown;
      if (typeof decoded === "string") {
        return decoded;
      }
    } catch {
      // Fall through to the bounded error below.
    }
    throw new CliError("RUNTIME", `Malformed YAML key in ${configPath}.`);
  }
  if (key.startsWith("'")) {
    if (!key.endsWith("'")) {
      throw new CliError("RUNTIME", `Malformed YAML key in ${configPath}.`);
    }
    return key.slice(1, -1).replaceAll("''", "'");
  }
  if (/[[\]{}#,]|:\s/u.test(key)) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely edit YAML key in ${configPath}.`
    );
  }
  return key;
};

const findColon = (text: string): number => {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote === '"') {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'" && text[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ":") {
      return index;
    }
  }
  return -1;
};

const linePair = (
  line: LineSpan,
  indent: number,
  configPath: string
): Omit<YamlPairSpan, "end" | "valueEnd"> | null => {
  if (countIndent(line.text) !== indent) {
    return null;
  }
  const body = line.text.slice(indent);
  if (!body.trim() || body.trimStart().startsWith("#")) {
    return null;
  }
  if (body.startsWith("?")) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely edit explicit YAML keys in ${configPath}.`
    );
  }
  const colon = findColon(body);
  if (colon === -1) {
    throw new CliError("RUNTIME", `Malformed YAML in ${configPath}.`);
  }
  const key = decodeKey(body.slice(0, colon), configPath);
  const valueOffset = line.start + indent + colon + 1;
  const valueStart =
    valueOffset +
    (/^ */u.exec(line.text.slice(valueOffset - line.start))?.[0].length ?? 0);
  return { key, start: line.start, valueStart };
};

const blockMap = (
  content: string,
  start: number,
  end: number,
  indent: number,
  configPath: string
): YamlMapSpan => {
  const candidates = linesOf(content).filter(
    (line) => line.start >= start && line.start < end
  );
  const partials: Array<Omit<YamlPairSpan, "end" | "valueEnd">> = [];
  for (const line of candidates) {
    const pair = linePair(line, indent, configPath);
    if (pair) {
      partials.push(pair);
    }
  }
  const items = partials.map((pair, index) => {
    const pairEnd = partials[index + 1]?.start ?? end;
    return { ...pair, end: pairEnd, valueEnd: pairEnd };
  });
  return { kind: "block", start, end, indent: " ".repeat(indent), items };
};

const matchingBrace = (
  content: string,
  open: number,
  configPath: string
): number => {
  let quote: "'" | '"' | null = null;
  let comment = false;
  const stack: string[] = [];
  for (let index = open; index < content.length; index += 1) {
    const char = content[index];
    if (comment) {
      if (char === "\n") {
        comment = false;
      }
      continue;
    }
    if (quote === '"') {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === "'" && content[index + 1] === "'") {
        index += 1;
      } else if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      comment = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.pop() !== expected) {
        break;
      }
      if (stack.length === 0) {
        return index;
      }
    }
  }
  throw new CliError("RUNTIME", `Malformed flow YAML in ${configPath}.`);
};

interface FlowSegment {
  start: number;
  end: number;
  commaBefore?: number;
  commaAfter?: number;
}

const flowSegments = (
  content: string,
  start: number,
  end: number
): FlowSegment[] => {
  const commas: number[] = [];
  let quote: "'" | '"' | null = null;
  let comment = false;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const char = content[index];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && content[index + 1] === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") comment = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) commas.push(index);
  }
  const boundaries = [start - 1, ...commas, end];
  const segments: FlowSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const rawStart = (boundaries[index] as number) + 1;
    const rawEnd = boundaries[index + 1] as number;
    if (!content.slice(rawStart, rawEnd).trim()) continue;
    segments.push({
      start: rawStart,
      end: rawEnd,
      commaBefore: index > 0 ? boundaries[index] : undefined,
      commaAfter:
        index < boundaries.length - 2 ? boundaries[index + 1] : undefined,
    });
  }
  return segments;
};

const flowMap = (
  content: string,
  open: number,
  configPath: string
): YamlMapSpan => {
  const close = matchingBrace(content, open, configPath);
  const items = flowSegments(content, open + 1, close).map((segment) => {
    const raw = content.slice(segment.start, segment.end);
    const colon = findColon(raw);
    if (colon === -1) {
      throw new CliError("RUNTIME", `Malformed flow YAML in ${configPath}.`);
    }
    const leading = /^\s*/u.exec(raw)?.[0].length ?? 0;
    const trailing = /\s*$/u.exec(raw)?.[0].length ?? 0;
    const start = segment.start + leading;
    const end = segment.end - trailing;
    const key = decodeKey(raw.slice(leading, colon), configPath);
    const rawAfterColon = raw.slice(colon + 1);
    const valueStart =
      segment.start +
      colon +
      1 +
      (/^\s*/u.exec(rawAfterColon)?.[0].length ?? 0);
    return {
      key,
      start,
      end,
      valueStart,
      valueEnd: end,
      commaBefore: segment.commaBefore,
      commaAfter: segment.commaAfter,
    };
  });
  return { kind: "flow", start: open, end: close + 1, indent: "", items };
};

const uniquePair = (
  map: YamlMapSpan,
  key: string,
  configPath: string
): YamlPairSpan | undefined => {
  const matches = map.items.filter((item) => item.key === key);
  if (matches.length > 1) {
    throw new CliError(
      "RUNTIME",
      `Malformed YAML in ${configPath}: duplicate ${key} key.`
    );
  }
  return matches[0];
};

const valueToken = (content: string, pair: YamlPairSpan): string =>
  content
    .slice(
      pair.valueStart,
      Math.min(
        pair.valueEnd,
        content.indexOf("\n", pair.valueStart) === -1
          ? content.length
          : content.indexOf("\n", pair.valueStart)
      )
    )
    .trim();

const childBlockMap = (
  content: string,
  pair: YamlPairSpan,
  parentIndent: number,
  configPath: string
): YamlMapSpan => {
  const lines = linesOf(content).filter(
    (line) => line.start >= pair.valueStart && line.start < pair.end
  );
  const firstChild = lines.find((line) => {
    const trimmed = line.text.trim();
    return (
      trimmed &&
      !trimmed.startsWith("#") &&
      countIndent(line.text) > parentIndent
    );
  });
  const indent = firstChild ? countIndent(firstChild.text) : parentIndent + 2;
  return blockMap(content, pair.valueStart, pair.end, indent, configPath);
};

export function scanYamlTarget(
  content: string,
  configPath: string,
  serversKey: string
): YamlTargetLayout {
  if (/^(?:---|\.\.\.)(?:\s*(?:#.*)?)?$/mu.test(content)) {
    throw new CliError(
      "RUNTIME",
      `Multi-document YAML is unsupported in ${configPath}.`
    );
  }
  const first = /[^\s#]/u.exec(content);
  if (first?.[0] === "{") {
    const root = flowMap(content, first.index, configPath);
    if (root.items.some((item) => item.key === "<<")) {
      throw new CliError(
        "RUNTIME",
        `Cannot safely edit a merged YAML root in ${configPath}.`
      );
    }
    const serversPair = uniquePair(root, serversKey, configPath);
    if (!serversPair) return { root };
    const token = valueToken(content, serversPair);
    if (!token.startsWith("{")) {
      throw new CliError(
        "RUNTIME",
        `${serversKey} in ${configPath} must be a map.`
      );
    }
    const servers = flowMap(content, serversPair.valueStart, configPath);
    return {
      root,
      serversPair,
      servers,
      gnoPair: uniquePair(servers, "gno", configPath),
    };
  }

  const root = blockMap(content, 0, content.length, 0, configPath);
  if (root.items.some((item) => item.key === "<<")) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely edit a merged YAML root in ${configPath}.`
    );
  }
  const serversPair = uniquePair(root, serversKey, configPath);
  if (!serversPair) return { root };
  const token = valueToken(content, serversPair);
  if (/^(?:[&*!]|!!)/u.test(token)) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely edit aliased or tagged ${serversKey} in ${configPath}.`
    );
  }
  let servers: YamlMapSpan;
  if (token.startsWith("{")) {
    servers = flowMap(content, serversPair.valueStart, configPath);
  } else if (
    !token ||
    token.startsWith("#") ||
    token.startsWith("\r") ||
    token.startsWith("\n")
  ) {
    servers = childBlockMap(content, serversPair, 0, configPath);
  } else {
    throw new CliError(
      "RUNTIME",
      `${serversKey} in ${configPath} must be a map.`
    );
  }
  if (servers.items.some((item) => item.key === "<<")) {
    throw new CliError(
      "RUNTIME",
      `Cannot safely edit merged ${serversKey} in ${configPath}.`
    );
  }
  return {
    root,
    serversPair,
    servers,
    gnoPair: uniquePair(servers, "gno", configPath),
  };
}
