import { expect, test } from "bun:test";

import { parseMetadataFilter } from "../../../src/serve/public/lib/metadata-filter";
import {
  applyFiltersToUrl,
  parseFiltersFromSearch,
} from "../../../src/serve/public/lib/retrieval-filters";

test("metadata filter preserves exact scalar types and rejects malformed or incompatible values", () => {
  expect(
    parseMetadataFilter('{"op":"eq","key":"enabled","value":false}').filter
  ).toEqual({ op: "eq", key: "enabled", value: false });
  expect(
    parseMetadataFilter('{"op":"gte","key":"confidence","value":"0.8"}').error
  ).toMatch(/^filter[.:]/);
  expect(
    parseMetadataFilter('{"op":"eq","key":"status","value":').error
  ).toMatch(/^filter[.:]/);
  expect(parseMetadataFilter(" ")).toEqual({});
});

test("shareable filter state retains valid and invalid predicates without silently broadening", () => {
  for (const text of [
    '{"op":"not","predicate":{"op":"exists","key":"status","value":true}}',
    '{"op":broken',
  ]) {
    const url = new URL("http://localhost/search");
    applyFiltersToUrl(url, { ...parseFiltersFromSearch(""), filter: text });
    expect(parseFiltersFromSearch(url.search).filter).toBe(text);
  }
});
