// node:path provides path joining; Bun has no path utilities.
import { join } from "node:path";

import {
  buildContextCapsuleDemoArtifact,
  CONTEXT_CAPSULE_DEMO_ROOT,
  renderContextCapsuleDemoMarkdown,
} from "./context-capsule";

const artifact = await buildContextCapsuleDemoArtifact();
const jsonPath = join(CONTEXT_CAPSULE_DEMO_ROOT, "context-capsule.json");
const markdownPath = join(CONTEXT_CAPSULE_DEMO_ROOT, "context-capsule.md");
await Bun.write(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`);
await Bun.write(markdownPath, renderContextCapsuleDemoMarkdown(artifact));
await Bun.$`bunx oxfmt ${jsonPath} ${markdownPath}`.quiet();
