import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ValidatedManifest } from "../../operation-registry/src/index.js";

export class OperationSnapshotRepository {
  constructor(readonly pool: Pool) {}

  async saveManifest(manifest: ValidatedManifest): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const operation of manifest.operations) {
        await client.query(
          `INSERT INTO operation_snapshot
             (snapshot_id, provider_id, provider_version, operation_name, manifest_hash, definition)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (provider_id, provider_version, operation_name, manifest_hash) DO NOTHING`,
          [
            randomUUID(),
            manifest.providerId,
            manifest.providerVersion,
            operation.name,
            manifest.manifestHash,
            JSON.stringify(operation.definition),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
