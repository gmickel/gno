import { describe, expect, test } from "bun:test";

describe("general embedding benchmark fixtures", () => {
  test("fixture corpus and provenance manifest are present", async () => {
    const sources = (await Bun.file(
      "evals/fixtures/general-embedding-benchmark/sources.json"
    ).json()) as Array<{
      id: string;
      language: string;
      license: string;
      sourceRepo: string;
      topic: string;
    }>;

    expect(sources.length).toBe(15);
    expect(new Set(sources.map((item) => item.language)).size).toBe(5);
    expect(new Set(sources.map((item) => item.topic)).size).toBe(3);
    expect(new Set(sources.map((item) => item.license))).toEqual(
      new Set(["MIT"])
    );

    for (const source of sources) {
      const file = Bun.file(
        `evals/fixtures/general-embedding-benchmark/corpus/${source.id}`
      );
      expect(await file.exists()).toBe(true);
      expect(source.sourceRepo).toContain("fastapi/fastapi");
    }
  });

  test("queries cover same-language and cross-language cases", async () => {
    const queries = (await Bun.file(
      "evals/fixtures/general-embedding-benchmark/queries.json"
    ).json()) as Array<{
      caseSet: string;
      queryLanguage: string;
      relevantDocs: string[];
    }>;

    expect(queries.length).toBeGreaterThanOrEqual(10);
    expect(new Set(queries.map((item) => item.caseSet))).toEqual(
      new Set(["same-language", "cross-language"])
    );
    expect(
      queries.some(
        (item) =>
          item.caseSet === "cross-language" &&
          !item.relevantDocs.some((doc) =>
            doc.startsWith(`${item.queryLanguage}/`)
          )
      )
    ).toBe(true);
  });

  test("benchmark script supports candidate dry-run", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "scripts/general-embedding-benchmark.ts",
        "--candidate",
        "bge-m3-incumbent",
        "--dry-run",
      ],
      {
        cwd: process.cwd(),
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("bge-m3-incumbent");
  });
});
