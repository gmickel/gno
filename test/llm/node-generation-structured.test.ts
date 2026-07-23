import { describe, expect, mock, test } from "bun:test";

import {
  promptWithJsonSchemaGrammar,
  type StructuredPromptSession,
} from "../../src/llm/nodeLlamaCpp/generation";

describe("node-llama-cpp structured generation", () => {
  test("passes the JSON grammar to the prompt and validates the response", async () => {
    let receivedGrammar: unknown;
    const prompt = mock(
      async (
        _prompt: string,
        options: Parameters<StructuredPromptSession["prompt"]>[1]
      ): Promise<string> => {
        receivedGrammar = options.grammar;
        return '{"status":"supported"}';
      }
    );
    const parse = mock((_response: string): void => undefined);
    const grammar = { parse };

    const response = await promptWithJsonSchemaGrammar(
      { prompt },
      "verify",
      {
        temperature: 0,
        seed: 42,
        maxTokens: 256,
      },
      grammar
    );

    expect(response).toBe('{"status":"supported"}');
    expect(receivedGrammar).toBe(grammar);
    expect(parse).toHaveBeenCalledWith('{"status":"supported"}');
  });

  test("propagates grammar validation failures to the fail-closed adapter boundary", async () => {
    const prompt = mock(
      async (): Promise<string> => '{"status":"unsupported"}'
    );
    const grammar = {
      parse: mock((): never => {
        throw new Error("schema mismatch");
      }),
    };

    let failure: unknown;
    try {
      await promptWithJsonSchemaGrammar(
        { prompt },
        "verify",
        {
          temperature: 0,
          seed: 42,
          maxTokens: 256,
        },
        grammar
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("schema mismatch");
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
