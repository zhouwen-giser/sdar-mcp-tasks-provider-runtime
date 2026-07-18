import { readFileSync } from "node:fs";
import { z } from "zod";
import type { LightResourceConfig } from "../types.js";

const resourceSchema = z.object({
  resourceId: z.string().min(1).max(128),
  entityId: z.string().regex(/^light\.[a-z0-9_]+$/),
  displayName: z.string().min(1).max(256),
  enabled: z.boolean().default(true),
  expectedCapabilities: z.object({ power: z.boolean(), brightness: z.boolean() }),
});
const fileSchema = z.object({ resources: z.array(resourceSchema).min(1) });

export function loadResourceConfig(path: string): LightResourceConfig[] {
  const parsed = fileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  ensureUnique(
    parsed.resources.map((resource) => resource.resourceId),
    "DUPLICATE_RESOURCE_ID",
  );
  ensureUnique(
    parsed.resources.map((resource) => resource.entityId),
    "DUPLICATE_ENTITY_ID",
  );
  return parsed.resources;
}

function ensureUnique(values: string[], reason: string): void {
  if (new Set(values).size !== values.length) throw new Error(reason);
}
