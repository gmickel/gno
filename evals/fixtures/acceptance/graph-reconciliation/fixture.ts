import type { NormalizedContentTypeRule } from "../../../../src/config";

export const sizes = [101, 1001, 5001] as const;
export const mutations = [
  "initial",
  "add",
  "ambiguous",
  "unique",
  "delete",
  "restore",
  "rename",
  "title",
  "config",
  "source-disappears",
] as const;

export function rules(hint = "mentions"): NormalizedContentTypeRule[] {
  return [
    {
      id: "meeting",
      prefixes: [],
      preset: "meeting",
      graphHints: [hint],
      searchBoost: 1,
    },
  ];
}

export function initialSources(): Record<string, string> {
  return {
    "outside/source.md":
      '---\ntype: meeting\nrelations:\n  knows: ["targets:Future"]\n---\n# Source\n[[targets:Future]]\n[[targets:Renamed]]\n',
    "outside/peer.md": "# Peer\n[[targets:Future]]\n",
    "targets/anchor.md": "# Anchor\n",
  };
}

export function mutate(sources: Record<string, string>, step: string): void {
  switch (step) {
    case "add":
    case "restore":
      sources["targets/opaque.md"] = "# Future\n";
      break;
    case "ambiguous":
      sources["targets/duplicate.md"] = "# Future\n";
      break;
    case "unique":
      delete sources["targets/duplicate.md"];
      break;
    case "delete":
      delete sources["targets/opaque.md"];
      break;
    case "rename":
      sources["targets/moved.md"] = sources["targets/opaque.md"]!;
      delete sources["targets/opaque.md"];
      break;
    case "title":
      sources["targets/moved.md"] = "# Renamed\n";
      break;
    case "source-disappears":
      delete sources["outside/source.md"];
      break;
    default:
      break;
  }
}
