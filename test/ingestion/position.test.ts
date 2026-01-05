/**
 * Tests for line/column position utilities.
 *
 * @module test/ingestion/position
 */

import { describe, expect, test } from "bun:test";

import {
  buildLineOffsets,
  offsetToPosition,
  offsetsToPositions,
} from "../../src/ingestion/position";

describe("buildLineOffsets", () => {
  test("handles single line", () => {
    const content = "hello world";
    const offsets = buildLineOffsets(content);
    expect(offsets).toEqual([0]);
  });

  test("handles multiple lines with LF", () => {
    const content = "line1\nline2\nline3";
    const offsets = buildLineOffsets(content);
    expect(offsets).toEqual([0, 6, 12]);
  });

  test("handles multiple lines with CRLF", () => {
    const content = "line1\r\nline2\r\nline3";
    const offsets = buildLineOffsets(content);
    // CRLF: \r\n is two chars, but buildLineOffsets only tracks \n
    // line1 (5) + \r\n (2) = 7, line2 (5) + \r\n (2) = 14
    expect(offsets).toEqual([0, 7, 14]);
  });

  test("handles trailing newline", () => {
    const content = "line1\nline2\n";
    const offsets = buildLineOffsets(content);
    expect(offsets).toEqual([0, 6, 12]);
  });

  test("handles empty string", () => {
    const offsets = buildLineOffsets("");
    expect(offsets).toEqual([0]);
  });

  test("handles just a newline", () => {
    const offsets = buildLineOffsets("\n");
    expect(offsets).toEqual([0, 1]);
  });

  test("handles multiple consecutive newlines", () => {
    const content = "a\n\nb";
    const offsets = buildLineOffsets(content);
    expect(offsets).toEqual([0, 2, 3]);
  });
});

describe("offsetToPosition", () => {
  test("returns 1-based positions", () => {
    const content = "abc\ndef\nghi";
    const offsets = buildLineOffsets(content);

    // First char 'a' is line 1, col 1
    expect(offsetToPosition(0, offsets)).toEqual({ line: 1, col: 1 });
  });

  test("maps offset to correct line and column", () => {
    const content = "abc\ndef\nghi";
    // Offsets: a=0, b=1, c=2, \n=3, d=4, e=5, f=6, \n=7, g=8, h=9, i=10
    const offsets = buildLineOffsets(content);

    expect(offsetToPosition(0, offsets)).toEqual({ line: 1, col: 1 }); // 'a'
    expect(offsetToPosition(2, offsets)).toEqual({ line: 1, col: 3 }); // 'c'
    expect(offsetToPosition(4, offsets)).toEqual({ line: 2, col: 1 }); // 'd'
    expect(offsetToPosition(5, offsets)).toEqual({ line: 2, col: 2 }); // 'e'
    expect(offsetToPosition(8, offsets)).toEqual({ line: 3, col: 1 }); // 'g'
    expect(offsetToPosition(10, offsets)).toEqual({ line: 3, col: 3 }); // 'i'
  });

  test("handles offset at newline", () => {
    const content = "abc\ndef";
    const offsets = buildLineOffsets(content);

    // Offset 3 is the \n character, which is col 4 of line 1
    expect(offsetToPosition(3, offsets)).toEqual({ line: 1, col: 4 });
  });

  test("handles negative offset", () => {
    const offsets = buildLineOffsets("hello");
    expect(offsetToPosition(-1, offsets)).toEqual({ line: 1, col: 1 });
  });

  test("handles empty line offsets", () => {
    expect(offsetToPosition(5, [])).toEqual({ line: 1, col: 1 });
  });

  test("handles offset beyond content", () => {
    const content = "abc";
    const offsets = buildLineOffsets(content);
    // Offset 10 is beyond content (length 3), but still computes from last line
    const pos = offsetToPosition(10, offsets);
    expect(pos.line).toBe(1);
    expect(pos.col).toBe(11); // offset 10 - line start 0 + 1 = 11
  });
});

describe("offsetsToPositions", () => {
  test("returns start and end positions", () => {
    const content = "abc\ndef\nghi";
    const offsets = buildLineOffsets(content);

    const { start, end } = offsetsToPositions(0, 3, offsets);
    expect(start).toEqual({ line: 1, col: 1 });
    expect(end).toEqual({ line: 1, col: 4 });
  });

  test("handles multi-line range", () => {
    const content = "abc\ndef\nghi";
    const offsets = buildLineOffsets(content);

    // Range from 'b' (offset 1) to 'h' (offset 9)
    const { start, end } = offsetsToPositions(1, 9, offsets);
    expect(start).toEqual({ line: 1, col: 2 }); // 'b'
    expect(end).toEqual({ line: 3, col: 2 }); // 'h'
  });
});

describe("binary search efficiency", () => {
  test("handles large content efficiently", () => {
    // Create content with 10000 lines
    const lines = Array.from({ length: 10000 }, (_, i) => `line${i}`);
    const content = lines.join("\n");
    const offsets = buildLineOffsets(content);

    expect(offsets.length).toBe(10000);

    // Verify binary search works for various positions
    const startTime = performance.now();
    for (let i = 0; i < 1000; i++) {
      const randomOffset = Math.floor(Math.random() * content.length);
      offsetToPosition(randomOffset, offsets);
    }
    const elapsed = performance.now() - startTime;

    // Should be very fast (<100ms for 1000 lookups on any modern machine)
    expect(elapsed).toBeLessThan(100);
  });
});
