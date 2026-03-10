#!/usr/bin/env bun
import { join } from "node:path";

import { collectLeaderboardRows } from "../lib/results";

const repoRoot = join(import.meta.dir, "../../../..");
const rows = await collectLeaderboardRows(repoRoot);

console.log(JSON.stringify(rows, null, 2));
