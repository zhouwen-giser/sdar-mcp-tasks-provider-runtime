import { ProviderError } from "../errors.js";
import type { LightResourceConfig } from "../types.js";

export class LightResourceRegistry {
  readonly #byResource = new Map<string, LightResourceConfig>();
  readonly #byEntity = new Map<string, LightResourceConfig>();

  constructor(resources: LightResourceConfig[]) {
    for (const resource of resources) {
      this.#byResource.set(resource.resourceId, resource);
      this.#byEntity.set(resource.entityId, resource);
    }
  }

  list(): LightResourceConfig[] {
    return [...this.#byResource.values()];
  }
  entityIds(): Set<string> {
    return new Set(this.#byEntity.keys());
  }
  fromEntity(entityId: string): LightResourceConfig | undefined {
    return this.#byEntity.get(entityId);
  }
  require(resourceId: string): LightResourceConfig {
    const resource = this.#byResource.get(resourceId);
    if (resource === undefined) throw new ProviderError("RESOURCE_NOT_CONFIGURED", false);
    if (!resource.enabled) throw new ProviderError("RESOURCE_DISABLED", false);
    return resource;
  }
}
