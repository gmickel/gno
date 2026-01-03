/**
 * Expansion schema validity scorer.
 * Validates expansion output against JSON schema.
 *
 * @module evals/scorers/expansion-validity
 */

import Ajv from "ajv";
import { createScorer } from "evalite";

import expansionSchema from "../../spec/output-schemas/expansion.schema.json";

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(expansionSchema);

interface ExpansionOutput {
  lexicalQueries?: string[];
  vectorQueries?: string[];
  hyde?: string;
  notes?: string;
}

/**
 * Validates expansion output matches the JSON schema.
 */
export const expansionSchemaValid = createScorer<
  string,
  ExpansionOutput,
  undefined
>({
  name: "Schema Valid",
  description: "Checks if expansion output matches JSON schema",
  scorer: ({ output }) => {
    const valid = validate(output);
    return {
      score: valid ? 1 : 0,
      metadata: valid
        ? { valid: true }
        : { valid: false, errors: validate.errors?.slice(0, 3) },
    };
  },
});

/**
 * Checks if expansion produced lexical query variants.
 */
export const hasLexicalVariants = createScorer<
  string,
  ExpansionOutput,
  undefined
>({
  name: "Has Lexical",
  description: "Checks if expansion produced lexical query variants",
  scorer: ({ output }) => {
    const hasLexical =
      Array.isArray(output?.lexicalQueries) && output.lexicalQueries.length > 0;
    return {
      score: hasLexical ? 1 : 0,
      metadata: { count: output?.lexicalQueries?.length ?? 0 },
    };
  },
});

/**
 * Checks if expansion produced vector query variants.
 */
export const hasVectorVariants = createScorer<
  string,
  ExpansionOutput,
  undefined
>({
  name: "Has Vector",
  description: "Checks if expansion produced vector query variants",
  scorer: ({ output }) => {
    const hasVector =
      Array.isArray(output?.vectorQueries) && output.vectorQueries.length > 0;
    return {
      score: hasVector ? 1 : 0,
      metadata: { count: output?.vectorQueries?.length ?? 0 },
    };
  },
});
