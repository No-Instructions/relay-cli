import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "No-Instructions/relay-cli";
export const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
export const BUNDLE = "release-provenance.sigstore.json";
export const SUBJECTS = ["version.txt", ...PLATFORMS.flatMap(platform => {
  const archive = `relay-cli-${platform}.tar.gz`;
  return [archive, `${archive}.sha256`];
})];
const ASSETS = [...SUBJECTS, BUNDLE].sort();
const execute = (command, args) => execFileSync(command, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024,
});
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = file => fs.readFileSync(file, "utf8");

export function releaseInputs(env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "Releases run only in the product repository");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Dispatch releases from main");
  assert.match(env.RELEASE_VERSION ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Expected a stable version without v");
  assert.match(env.RELEASE_COMMIT ?? "", /^[a-f0-9]{40}$/, "Expected a reviewed full product SHA");
  assert.ok(["prepare", "publish"].includes(env.RELEASE_OPERATION), "Expected prepare or publish");
  if (env.RELEASE_OPERATION === "prepare") {
    assert.equal(env.RELEASE_COMMIT, env.GITHUB_SHA, "main moved: review the new commit before preparing a release");
  }
  return { version: env.RELEASE_VERSION, revision: env.RELEASE_COMMIT };
}

// Inspect metadata without extracting or running executables from other platforms.
export function verifyPlatform(directory, platform, { version, revision }, bunVersion) {
  assert.equal(read(path.join(directory, "version.txt")), `${version}\n`, `${platform}: wrong version.txt`);
  const archive = `relay-cli-${platform}.tar.gz`;
  assert.equal(read(path.join(directory, `${archive}.sha256`)), `${digest(path.join(directory, archive))}  ${archive}\n`, `${platform}: checksum mismatch`);
  const members = execute("tar", ["-tzf", path.join(directory, archive)]).trim().split("\n");
  assert.equal(members.filter(name => name === "release.json").length, 1, "Expected one release.json");
  assert.ok(members.includes("relay") && members.includes("LICENSE"), "Missing executable or license");
  assert.ok(members.every(name => !name.startsWith("/") && !name.split("/").includes("..")
    && (["relay", "release.json", "LICENSE"].includes(name) || name.startsWith("licenses/"))), "Unexpected archive contents");
  const metadata = JSON.parse(execute("tar", ["-xOzf", path.join(directory, archive), "release.json"]));
  const [system, arch] = platform.split("-");
  assert.deepEqual(metadata, {
    format: 1, version, revision, target: "production", runtime: "bun", bunVersion,
    platform: system, arch,
  }, `${platform}: release metadata does not match the reviewed build`);
}

export function collectArtifacts(input, output, release, bunVersion) {
  // Keep platform directories separate until each version and revision is checked.
  for (const platform of PLATFORMS) verifyPlatform(path.join(input, `release-${platform}`), platform, release, bunVersion);
  fs.mkdirSync(output); // Refuse a stale/mixed output directory.
  for (const platform of PLATFORMS) {
    const archive = `relay-cli-${platform}.tar.gz`;
    for (const name of [archive, `${archive}.sha256`]) fs.copyFileSync(path.join(input, `release-${platform}`, name), path.join(output, name));
  }
  fs.writeFileSync(path.join(output, "version.txt"), `${release.version}\n`);
}

export function releaseClient({ version, revision }, gh = args => execute("gh", args)) {
  const tag = `v${version}`;
  const api = endpoint => JSON.parse(gh(["api", `repos/${REPOSITORY}/${endpoint}`]));
  const releases = () => JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${REPOSITORY}/releases?per_page=100`])).flat();
  const current = () => releases().find(release => release.tag_name === tag);
  const requireTarget = release => {
    assert.equal(release.target_commitish, revision, "Release target differs from the reviewed SHA");
    assert.equal(release.prerelease, false, "Expected a stable release");
    const refs = api(`git/matching-refs/tags/${tag}`);
    if (refs.some(ref => ref.ref === `refs/tags/${tag}`)) {
      assert.equal(api(`commits/${tag}`).sha, revision, "Existing tag points to another commit");
    }
  };
  const download = directory => gh(["release", "download", tag, "--repo", REPOSITORY, "--dir", directory]);
  const verify = (directory, bunVersion) => {
    assert.deepEqual(fs.readdirSync(directory).sort(), ASSETS, "Release must contain exactly the expected assets");
    for (const platform of PLATFORMS) verifyPlatform(directory, platform, { version, revision }, bunVersion);
    for (const name of SUBJECTS) gh([
      "attestation", "verify", path.join(directory, name), "--repo", REPOSITORY,
      "--bundle", path.join(directory, BUNDLE),
      "--signer-workflow", `${REPOSITORY}/.github/workflows/release.yml`,
      "--source-ref", "refs/heads/main", "--source-digest", revision,
      "--deny-self-hosted-runners",
    ]);
  };
  return {
    verify,
    preflight(operation) {
      const release = current();
      if (operation === "prepare") {
        assert.ok(!release, "This version already exists; resume failed jobs or publish the reviewed draft");
        assert.ok(!api(`git/matching-refs/tags/${tag}`).some(ref => ref.ref === `refs/tags/${tag}`), "Release tag already exists");
      } else {
        assert.ok(release, "Prepare the release draft first");
        requireTarget(release);
      }
    },
    draft(directory, bunVersion) {
      verify(directory, bunVersion);
      let release = current();
      if (!release) {
        gh(["release", "create", tag, "--repo", REPOSITORY, "--target", revision,
          "--draft", "--title", `Relay CLI ${version}`, "--generate-notes"]);
        release = current();
      }
      assert.ok(release?.draft, "Never replace assets in a published release");
      requireTarget(release);
      const existing = fs.mkdtempSync(path.join(os.tmpdir(), "relay-draft-"));
      try {
        if (release.assets.length) download(existing);
        // A retry may fill missing uploads, but never replace a different byte.
        for (const name of fs.readdirSync(existing)) {
          assert.ok(ASSETS.includes(name), `Unexpected draft asset: ${name}`);
          assert.equal(digest(path.join(existing, name)), digest(path.join(directory, name)), `Draft asset differs: ${name}`);
        }
        const missing = ASSETS.filter(name => !fs.existsSync(path.join(existing, name)));
        if (missing.length) gh(["release", "upload", tag, "--repo", REPOSITORY, ...missing.map(name => path.join(directory, name))]);
      } finally { fs.rmSync(existing, { recursive: true, force: true }); }
      const uploaded = fs.mkdtempSync(path.join(os.tmpdir(), "relay-uploaded-"));
      try { download(uploaded); verify(uploaded, bunVersion); }
      finally { fs.rmSync(uploaded, { recursive: true, force: true }); }
    },
    publish(directory, bunVersion) {
      const release = current();
      assert.ok(release, "Prepare the release draft first");
      requireTarget(release);
      fs.mkdirSync(directory);
      download(directory);
      verify(directory, bunVersion);
      if (release.draft) gh(["release", "edit", tag, "--repo", REPOSITORY, "--draft=false"]);
      assert.equal(current().immutable, true, "Published release is not immutable; enable immutable releases in repository settings");
      assert.equal(api(`commits/${tag}`).sha, revision, "Published tag differs from the reviewed SHA");
      // Rerunning publish verifies the existing release without changing it.
      gh(["release", "verify", tag, "--repo", REPOSITORY]);
      for (const name of ASSETS) gh(["release", "verify-asset", tag, path.join(directory, name), "--repo", REPOSITORY]);
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = releaseInputs(process.env);
    const [command, first, second] = process.argv.slice(2);
    // Publishing an older draft uses its original Bun pin, read at the reviewed SHA.
    const bunVersion = execute("git", ["show", `${release.revision}:.bun-version`]).trim();
    const client = releaseClient(release);
    if (command === "preflight") client.preflight(process.env.RELEASE_OPERATION);
    else if (command === "collect") collectArtifacts(first, second, release, bunVersion);
    else if (["verify", "draft", "publish"].includes(command)) client[command](first, bunVersion);
    else throw new Error("Expected preflight, collect, verify, draft, or publish");
    if (["draft", "publish"].includes(command)) {
      const summary = `### Relay CLI ${release.version}\n\n${command === "draft" ? "Draft prepared for review" : "Published release verified"}. Source: \`${release.revision}\`.\n\n[Release](https://github.com/${REPOSITORY}/releases/tag/v${release.version})\n`;
      console.log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
