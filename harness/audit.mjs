/**
 * Runtime audit: boot pi's real DefaultResourceLoader against the live agent
 * dir and report every extension that would actually load, plus duplicates.
 *
 * This is the authoritative check — DefaultPackageManager says what is
 * *resolved*, the loader says what the runtime ends up running.
 *
 * Run: node harness/audit.mjs [agentDir]
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const CANDIDATE_ROOTS = [
  path.join(os.homedir(), ".pi", "agent", "install", "releases"),
  "E:/pi/Pi Agent/resources/server/node_modules",
];

function resolvePiRoot() {
  if (process.env.PI_MODULES_ROOT) return process.env.PI_MODULES_ROOT;
  for (const root of CANDIDATE_ROOTS) {
    if (root.endsWith("releases")) {
      if (!fs.existsSync(root)) continue;
      for (const version of fs.readdirSync(root)) {
        const modules = path.join(root, version, "node_modules");
        if (fs.existsSync(path.join(modules, "@earendil-works/pi-coding-agent"))) return modules;
      }
      continue;
    }
    if (fs.existsSync(path.join(root, "@earendil-works/pi-coding-agent"))) return root;
  }
  throw new Error("could not locate a pi installation; set PI_MODULES_ROOT");
}

const PI_ROOT = resolvePiRoot();
const pkgDir = path.join(PI_ROOT, "@earendil-works/pi-coding-agent");
const asUrl = (target) => "file://" + target.replace(/\\/g, "/");

const { DefaultResourceLoader } = await import(asUrl(path.join(pkgDir, "dist/core/resource-loader.js")));
const { SettingsManager } = await import(asUrl(path.join(pkgDir, "dist/core/settings-manager.js")));
const { getAgentDir } = await import(asUrl(path.join(pkgDir, "dist/config.js")));

const agentDir = process.argv[2] || process.env.PI_CODING_AGENT_DIR || getAgentDir();
const cwd = process.env.AUDIT_CWD || path.join(os.homedir());

console.log("agentDir:", agentDir);
console.log("cwd     :", cwd);
console.log("");

const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager: settings,
  extensionFactories: [],
});

await loader.reload();
const result = loader.getExtensions() ?? {};
const extensions = result.extensions ?? [];

console.log("=== extensions the runtime would load ===");
const seen = new Map();
for (const extension of extensions) {
  const target = String(extension.path ?? extension.name ?? "?");
  seen.set(target, (seen.get(target) ?? 0) + 1);
  const handlerCount =
    extension.handlers instanceof Map ? extension.handlers.size : Object.keys(extension.handlers ?? {}).length;
  console.log(
    "  " +
      target +
      "\n     tools=" +
      (extension.tools?.size ?? 0) +
      " commands=" +
      (extension.commands?.size ?? 0) +
      " eventKinds=" +
      handlerCount,
  );
}

const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
console.log("");
console.log(
  "loaded:",
  extensions.length,
  "| unique:",
  seen.size,
  "| duplicates:",
  duplicates.length,
);
for (const [target, count] of duplicates) console.log("  DUPLICATE x" + count + ": " + target);

const errors = result.errors ?? [];
const warnings = result.warnings ?? [];
if (errors.length) {
  console.log("");
  console.log("=== errors ===");
  for (const error of errors) console.log("  x", error.path, String(error.error).split("\n")[0]);
}
if (warnings.length) {
  console.log("");
  console.log("=== warnings ===");
  for (const warning of warnings) {
    console.log("  !", warning.path ?? "", String(warning.message ?? "").split("\n")[0]);
  }
}

process.exit(duplicates.length > 0 || errors.length > 0 ? 1 : 0);
