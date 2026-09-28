import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { jsonSchemas } from "./json-schema.js";

it.each(Object.entries(jsonSchemas()))("json/%s is up to date (run `pnpm schema:generate`)", (file, schema) => {
  const onDisk = JSON.parse(readFileSync(join(import.meta.dirname, "../json", file), "utf8"));
  expect(onDisk).toEqual(schema);
});
