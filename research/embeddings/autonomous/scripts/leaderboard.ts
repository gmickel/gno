#!/usr/bin/env bun
import { join } from "node:path";

import { collectLeaderboardRows } from "../lib/results";

const repoRoot = join(import.meta.dir, "../../../..");
console.log(JSON.stringify(await collectLeaderboardRows(repoRoot), null, 2));
