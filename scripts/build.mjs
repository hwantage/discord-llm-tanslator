import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const requestedTarget = process.argv[2] || "all";
const allowedTargets = new Set(["all", "chromium", "firefox"]);

if (!allowedTargets.has(requestedTarget)) {
  throw new Error(`지원하지 않는 빌드 대상입니다: ${requestedTarget}`);
}

const targets = requestedTarget === "all" ? ["chromium", "firefox"] : [requestedTarget];
const files = ["shared.js", "inline-ui.js", "background.js", "content.js", "PRIVACY.md"];

for (const target of targets) {
  const outputDirectory = path.join(projectRoot, "dist", target);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));

  if (target === "chromium") {
    delete manifest.background.scripts;
    delete manifest.browser_specific_settings;
  } else {
    manifest.background = {
      scripts: ["shared.js", "background.js"]
    };
    manifest.optional_permissions = manifest.optional_host_permissions || [];
    delete manifest.optional_host_permissions;
  }

  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  for (const file of files) {
    await cp(path.join(projectRoot, file), path.join(outputDirectory, file));
  }

  await cp(path.join(projectRoot, "options"), path.join(outputDirectory, "options"), {
    recursive: true
  });
  const iconOutputDirectory = path.join(outputDirectory, "icons");
  await mkdir(iconOutputDirectory, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const filename = `icon-${size}.png`;
    await cp(path.join(projectRoot, "icons", filename), path.join(iconOutputDirectory, filename));
  }

  process.stdout.write(`built dist/${target}\n`);
}
