import { mkdir, readdir, rm, cp } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

export async function buildWebLLM(root, output) {
  const destination = path.join(output, "webllm");
  await mkdir(destination, { recursive: true });
  // Remove generated libraries from earlier builds, including unpacked root
  // installs. Builds never fetch or package model weights or model WASM files.
  for (const file of await readdir(destination)) {
    if (file.endsWith(".wasm")) await rm(path.join(destination, file));
  }
  if (path.resolve(output) !== path.resolve(root)) {
    for (const file of ["NOTICE.md", "catalog.json", "host.html", "sandbox.html"]) {
      await cp(path.join(root, "webllm", file), path.join(destination, file));
    }
    await cp(path.join(root, "webllm/licenses"), path.join(destination, "licenses"), { recursive: true });
  }
  for (const [entry, outfile] of [["entry", path.join(output, "webllm-provider.js")],
    ["host", path.join(destination, "host.js")], ["sandbox", path.join(destination, "sandbox.js")]]) {
    await build({ entryPoints: [path.join(root, `webllm/${entry}.mjs`)], outfile,
      bundle: true, format: "iife", platform: "browser", target: "es2022", minify: true, legalComments: "linked" });
  }
}
