import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ValidatedManifest } from "../../operation-registry/src/index.js";

export class OperationSnapshotRepository {
  constructor(readonly pool: Pool) {}

  async saveManifest(manifest: ValidatedManifest): Promise<Map<string, string>> {
    const client = await this.pool.connect();
    const snapshotIds = new Map<string, string>();
    try {
      await client.query("BEGIN");
      for (const operation of manifest.operations) {
        const saved = await client.query<{ snapshot_id: string }>(
          `INSERT INTO operation_snapshot
             (snapshot_id, provider_id, provider_version, operation_name, manifest_hash, definition)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (provider_id, provider_version, operation_name, manifest_hash)
           DO UPDATE SET definition = operation_snapshot.definition
           RETURNING snapshot_id`,
          [
            randomUUID(),
            manifest.providerId,
            manifest.providerVersion,
            operation.name,
            manifest.manifestHash,
            JSON.stringify(operation.definition),
          ],
        );
        const snapshotId = saved.rows[0]?.snapshot_id;
        if (snapshotId === undefined) throw new Error("OPERATION_SNAPSHOT_NOT_RETURNED");
        snapshotIds.set(operation.name, snapshotId);
      }
      await client.query("COMMIT");
      return snapshotIds;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
