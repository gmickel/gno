import { expect, test } from "bun:test";

import {
  body,
  changedBody,
  equivalent,
  expectedOwner,
  fixture,
  fixtureHash,
  model,
  nextModel,
  openHarness,
  whitespaceBody,
} from "../../evals/fixtures/acceptance/ingestion-identity/oracle";

test("frozen independent oracle rejects missing, stale, wrong-title and unproven legacy vectors", async () => {
  const pin = await Bun.file(
    new URL(
      "../../evals/fixtures/acceptance/ingestion-identity/manifest.json",
      import.meta.url
    )
  ).json();
  expect(fixtureHash).toBe(pin.sha256);
  const alpha = expectedOwner("Alpha.md", "Alpha");
  const beta = expectedOwner("Beta.md", "Beta");
  expect(alpha.mirror).toBe(beta.mirror);
  expect(alpha.embedding).not.toEqual(beta.embedding);
  expect(equivalent([alpha, beta], [alpha, beta])).toBe(true);
  for (const bad of [
    { ...beta, embedding: null },
    { ...beta, inputHash: null },
    { ...beta, embedding: alpha.embedding },
    {
      ...beta,
      embedding: expectedOwner("Beta.md", "Beta", nextModel).embedding,
    },
    {
      ...beta,
      embedding: expectedOwner("Alpha.md", "Alpha", model, true).embedding,
    },
  ])
    expect(equivalent([alpha, beta], [alpha, bad])).toBe(false);
});

test.each([false, true])(
  "characterization: title variants lose ownership in both orders (reverse=%s)",
  async (reverse) => {
    const h = await openHarness();
    const clean = await openHarness();
    try {
      const names = reverse
        ? (["Beta", "Alpha"] as const)
        : (["Alpha", "Beta"] as const);
      const calls = [];
      for (const name of names) {
        await h.write(`${name}.md`);
        await h.sync();
        calls.push(await h.embed());
      }
      for (const name of names) await clean.write(`${name}.md`);
      await clean.sync();
      const cleanCalls = await clean.embed();
      const expected = [
        expectedOwner("Alpha.md", "Alpha"),
        expectedOwner("Beta.md", "Beta"),
      ];
      expect(calls).toEqual(fixture.expectations.titleOrders.calls);
      expect(cleanCalls).toBe(1); // Known gap: oracle requires two independent inputs.
      expect(fixture.expectations.titleOrders.cleanCalls).toBe(2);
      expect(equivalent(expected, h.snapshot())).toBe(false);
      expect(equivalent(expected, clean.snapshot())).toBe(false);
      expect(new Set(h.calls.map((call) => call.input)).size).toBe(1);
    } finally {
      await h.close();
      await clean.close();
    }
  }
);

test.each(["sameTitle", "whitespace"] as const)(
  "characterization: %s deletes unchanged valid vector and repeats model work",
  async (scenario) => {
    const h = await openHarness();
    const clean = await openHarness();
    try {
      await h.write("Alpha.md");
      await h.sync();
      expect(await h.embed()).toBe(1);
      expect(
        equivalent([expectedOwner("Alpha.md", "Alpha")], h.snapshot())
      ).toBe(true);
      const name = scenario === "sameTitle" ? "copy/Alpha.md" : "Alpha.md";
      const source = scenario === "whitespace" ? whitespaceBody : body;
      await h.write(name, source);
      await h.sync();
      const expected = [expectedOwner("Alpha.md", "Alpha")];
      if (scenario === "sameTitle") expected.push(expectedOwner(name, "Alpha"));
      expect(equivalent(expected, h.snapshot())).toBe(false);
      expect(h.snapshot().every((owner) => owner.embedding === null)).toBe(
        true
      );
      expect(await h.embed()).toBe(1); // Required delta is zero; do not bless current work.
      expect(fixture.expectations[scenario].calls).toEqual([1, 0]);
      expect(await h.events()).toEqual(fixture.expectations[scenario].events);
      await clean.write("Alpha.md", scenario === "whitespace" ? source : body);
      if (scenario === "sameTitle") await clean.write(name);
      await clean.sync();
      await clean.embed();
      expect(equivalent(expected, clean.snapshot())).toBe(true);
      expect(equivalent(clean.snapshot(), h.snapshot())).toBe(true);
    } finally {
      await h.close();
      await clean.close();
    }
  }
);

test("true content and model changes need new input vectors; clean rebuild agrees", async () => {
  const h = await openHarness();
  const clean = await openHarness();
  try {
    await h.write("Alpha.md");
    await h.sync();
    expect(await h.embed()).toBe(1);
    await h.write("Alpha.md", changedBody);
    await h.sync();
    const expected = [expectedOwner("Alpha.md", "Alpha", model, true)];
    expect(equivalent(expected, h.snapshot())).toBe(false);
    expect(await h.embed()).toBe(1);
    expect(h.calls.map((call) => call.input)).toEqual([
      fixture.inputs.Alpha,
      fixture.inputs.changed,
    ]);
    expect(await h.events()).toEqual(fixture.expectations.content.events);
    expect(equivalent(expected, h.snapshot())).toBe(true);
    expect(await h.embed(nextModel)).toBe(1);
    expect(await h.embed(nextModel)).toBe(0);
    await clean.write("Alpha.md", changedBody);
    await clean.sync();
    await clean.embed(nextModel);
    expect(
      equivalent(
        [expectedOwner("Alpha.md", "Alpha", nextModel, true)],
        h.snapshot(nextModel)
      )
    ).toBe(true);
    expect(equivalent(clean.snapshot(nextModel), h.snapshot(nextModel))).toBe(
      true
    );
  } finally {
    await h.close();
    await clean.close();
  }
});
