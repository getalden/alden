/** Writes the JSON Schema files in packages/schema/json from the zod schemas: `pnpm schema:generate`. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { jsonSchemas } from "../packages/schema/src/json-schema.js";

const OUT_DIR = join(import.meta.dirname, "../packages/schema/json");
await mkdir(OUT_DIR, { recursive: true });
for (const [file, schema] of Object.entries(jsonSchemas())) {
  await writeFile(join(OUT_DIR, file), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote packages/schema/json/${file}`);
}
