import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { assetName, validateVersion } from "../src/updates.js";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const version = validateVersion(process.argv[2]);
const output = path.resolve(process.argv[3] ?? path.join(root, "dist/releases"));
const requiredBun = (await fs.readFile(new URL("../.bun-version", import.meta.url), "utf8")).trim();
if (process.versions.bun !== requiredBun) throw new Error(`Build releases with Bun ${requiredBun}.`);
if (process.argv.length > 4) throw new Error("Usage: bun scripts/build-release.mjs <version> [output-directory]");
const name = assetName();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Release builds require a Git revision.");
const release = { format: 1, version, revision, target: "production", runtime: "bun", bunVersion: requiredBun, platform: process.platform, arch: process.arch };
const addonTarget = `${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : ""}`;
const addon = require.resolve(`@napi-rs/keyring-${addonTarget}`);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "relay-release-"));
try {
  execFileSync(process.execPath, [path.join(root, "scripts/build-headless.mjs"), "production"], { cwd: root, stdio: "inherit" });
  const binary = path.join(temporary, "relay");
  const result = await Bun.build({
    entrypoints: [path.join(root, "bin/relay.js")],
    compile: {
      outfile: binary,
      target: `bun-${process.platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}`,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    define: { RMD_RELEASE_METADATA: JSON.stringify(release) },
    plugins: [{
      name: "embedded-keychain",
      setup(build) {
        // The generated NAPI loader probes external platform packages. Resolve
        // directly to this platform's addon so Bun embeds it in the executable.
        build.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({ path: addon }));
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, "Standalone build failed.");
  execFileSync(binary, ["version", "--verify", "--json"], { cwd: temporary, stdio: "inherit" });
  await fs.writeFile(path.join(temporary, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  await fs.copyFile(path.join(root, "LICENSE"), path.join(temporary, "LICENSE"));
  await fs.mkdir(path.join(temporary, "licenses"));
  for (const file of ["THIRD_PARTY_NOTICES.md", "LICENSE"]) {
    await fs.copyFile(path.join(root, "vendor/relay", file), path.join(temporary, "licenses", `relay-${file}`));
  }
  // Retain package licenses alongside the executable, including bundled native
  // dependencies. Source files, tests, credentials, and the harness are excluded.
  const licenses = [];
  async function collect(directory, relative = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), name);
      else if (/^(licen[cs]e|notice|copying)(\.|$)/i.test(entry.name)) {
        licenses.push(`\n--- ${name} ---\n${await fs.readFile(path.join(directory, entry.name), "utf8")}`);
      }
    }
  }
  await collect(path.join(root, "node_modules"));
  await fs.writeFile(path.join(temporary, "licenses/dependencies.txt"), licenses.join("\n"));
  const license = await fetch(`https://raw.githubusercontent.com/oven-sh/bun/bun-v${requiredBun}/LICENSE.md`);
  if (!license.ok) throw new Error("Could not retrieve the pinned Bun runtime license notices.");
  await fs.writeFile(path.join(temporary, "licenses/bun.txt"), await license.text());
  await fs.mkdir(output, { recursive: true });
  const archive = path.join(output, name);
  execFileSync("tar", ["-czf", archive, "-C", temporary, "relay", "release.json", "LICENSE", "licenses"]);
  const hash = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  await fs.writeFile(`${archive}.sha256`, `${hash}  ${name}\n`);
  await fs.writeFile(path.join(output, "version.txt"), `${version}\n`);
  console.log(`Built ${archive}`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
