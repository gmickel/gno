import {
  createDefaultConfig,
  type GnoClientInitOptions,
  type SearchResults,
} from "@gmickel/gno";
const config = createDefaultConfig();
const opts: GnoClientInitOptions = { config };
const results: SearchResults | null = null;
console.log(Boolean(opts), results === null);
