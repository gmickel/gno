import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

const schemaCache = new Map<string, object>();
let schemasLoaded = false;

async function loadAllSchemas(): Promise<void> {
  if (schemasLoaded) {
    return;
  }

  const schemaFiles = [
    "search-result",
    "search-results",
    "status",
    "get",
    "multi-get",
    "ask",
    "error",
    "mcp-capture-result",
    "mcp-add-collection-result",
    "mcp-sync-result",
    "mcp-remove-result",
    "mcp-job-status",
    "mcp-job-list",
  ];

  for (const name of schemaFiles) {
    const path = `spec/output-schemas/${name}.schema.json`;
    const schema = await Bun.file(path).json();
    schemaCache.set(name, schema);
    // Add schema to Ajv with a resolvable $id
    ajv.addSchema(schema, `${name}.schema.json`);
  }

  schemasLoaded = true;
}

export async function loadSchema(name: string): Promise<object> {
  await loadAllSchemas();
  const cached = schemaCache.get(name);
  if (!cached) {
    throw new Error(`Schema not found: ${name}`);
  }
  return cached;
}

export function createValidator(schema: object) {
  return ajv.compile(schema);
}

export function assertValid(data: unknown, schema: object): boolean {
  const validate = createValidator(schema);
  const valid = validate(data);
  if (!valid) {
    const errorMsg = JSON.stringify(validate.errors, null, 2);
    throw new Error(`Schema validation failed:\n${errorMsg}`);
  }
  return true;
}

export function assertInvalid(data: unknown, schema: object): boolean {
  const validate = createValidator(schema);
  const valid = validate(data);
  if (valid) {
    throw new Error("Expected validation to fail but it passed");
  }
  return true;
}
