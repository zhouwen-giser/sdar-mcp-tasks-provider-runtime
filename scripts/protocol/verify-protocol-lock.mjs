import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import process from "node:process";

const protocolRoot = resolve("protocol");
const lockPath = resolve(protocolRoot, "protocol-baseline.lock.json");
const write = process.argv.includes("--write");
const files = collect(protocolRoot)
  .filter((path) => path !== lockPath)
  .map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(protocolRoot, path).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const serialized = `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`;
if (write) {
  writeFileSync(lockPath, serialized, { mode: 0o644 });
  process.stdout.write(`Wrote protocol lock for ${files.length} files\n`);
} else {
  const committed = readFileSync(lockPath, "utf8");
  if (committed !== serialized) {
    throw new Error("Protocol lock mismatch; run pnpm protocol:generate && pnpm protocol:lock");
  }
  process.stdout.write(`Protocol lock verified for ${files.length} files\n`);
}

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return statSync(path).isFile() ? [path] : [];
  });
}
