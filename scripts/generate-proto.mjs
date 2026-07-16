import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { getProtoPath } from "google-proto-files";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "packages/adapter-protocol/generated");
const protoRoot = resolve(root, "proto");
const protoFile = resolve(protoRoot, "io/sdar/mcp/tasks/adapter/v1/adapter.proto");
const googleRoot = resolve(getProtoPath(), "..");
const bin = (name) =>
  resolve(root, "node_modules/.bin", process.platform === "win32" ? `${name}.cmd` : name);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const protocArgs = [
  `--proto_path=${protoRoot}`,
  `--proto_path=${googleRoot}`,
  `--js_out=import_style=commonjs,binary:${out}`,
  `--grpc_out=grpc_js:${out}`,
  protoFile,
];
const protoc = spawnSync(bin("grpc_tools_node_protoc"), protocArgs, {
  cwd: root,
  stdio: "inherit",
});
if (protoc.status !== 0) process.exit(protoc.status ?? 1);

const types = spawnSync(
  bin("grpc_tools_node_protoc"),
  [
    `--plugin=protoc-gen-ts=${bin("protoc-gen-ts")}`,
    `--ts_out=grpc_js:${out}`,
    `--proto_path=${protoRoot}`,
    `--proto_path=${googleRoot}`,
    protoFile,
  ],
  { cwd: root, stdio: "inherit" },
);
if (types.status !== 0) process.exit(types.status ?? 1);

for (const generatedType of [
  "io/sdar/mcp/tasks/adapter/v1/adapter_pb.d.ts",
  "io/sdar/mcp/tasks/adapter/v1/adapter_grpc_pb.d.ts",
]) {
  const path = resolve(out, generatedType);
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")
      .replace(/[ \t]+$/gm, "")
      .trimEnd()}\n`,
  );
}
writeFileSync(resolve(out, "package.json"), '{"type":"commonjs"}\n');
