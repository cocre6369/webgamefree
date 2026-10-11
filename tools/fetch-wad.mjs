#!/usr/bin/env node
/**
 * fetch-wad.mjs - (re)build web/assets/freedoom1.wad.gz
 *
 * The repository ships the compressed IWAD so the page works out of the box,
 * but here is how it got there - and how to refresh it when Freedoom makes a
 * new release.
 *
 * Freedoom Phase 1 is BSD-3-Clause licensed game data with no id Software
 * assets in it: 27.5 MiB of levels, sprites, textures, sounds and MIDI music.
 *
 * Sources are tried in order:
 *   1. --from <file>            an existing WAD on disk
 *   2. the official GitHub release (freedoom-<version>.zip)
 *   3. the npm package kaboom.claude, which vendors freedoom1.wad
 *
 * The result is gzipped (10.0 MiB, 2.9:1) because the browser decompresses it
 * with DecompressionStream - smaller download, no server-side decompression,
 * and the raw WAD never has to be stored uncompressed.
 *
 * Usage: node tools/fetch-wad.mjs [--from path/to/freedoom1.wad] [--force]
 */

import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "web/assets");
const target = join(assets, "freedoom1.wad.gz");

const FREEDOOM_VERSION = "0.13.0";
const RELEASE_ZIP = `https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VERSION}/freedoom-${FREEDOOM_VERSION}.zip`;
const NPM_FALLBACK = "https://registry.npmjs.org/kaboom.claude/-/kaboom.claude-1.5.3.tgz";

const force = process.argv.includes("--force");
const fromIndex = process.argv.indexOf("--from");
const fromPath = fromIndex > -1 ? process.argv[fromIndex + 1] : null;

if (existsSync(target) && !force && !fromPath) {
  console.log(`${target} already exists (${(statSync(target).size / 1048576).toFixed(1)} MiB) - use --force to refresh`);
  process.exit(0);
}

mkdirSync(assets, { recursive: true });
const work = join(tmpdir(), `freedoom-fetch-${Date.now()}`);
mkdirSync(work, { recursive: true });

/** Sanity check: an IWAD starts with "IWAD" and is tens of megabytes. */
function validate(wadPath) {
  const header = Buffer.alloc(4);
  const fd = readFileSync(wadPath, { flag: "r" }).subarray(0, 4);
  Buffer.from(fd).copy(header);
  const size = statSync(wadPath).size;
  const magic = header.toString("latin1");
  if (magic !== "IWAD") throw new Error(`${wadPath}: not an IWAD (magic ${JSON.stringify(magic)})`);
  if (size < 5 * 1048576) throw new Error(`${wadPath}: suspiciously small (${size} bytes)`);
  return size;
}

function download(url, destination) {
  console.log(`  fetching ${url}`);
  // curl keeps the download streaming (files here are 10-25 MiB).
  execFileSync("curl", ["-sSL", "--fail", "-o", destination, url], { stdio: ["ignore", "inherit", "inherit"] });
  return destination;
}

function unzip(zipPath, member, destination) {
  execFileSync("unzip", ["-o", "-j", zipPath, member, "-d", destination], { stdio: ["ignore", "inherit", "inherit"] });
}

let wadPath = null;

if (fromPath) {
  console.log(`using ${fromPath}`);
  wadPath = fromPath;
} else {
  // 1. official release
  try {
    const zip = download(RELEASE_ZIP, join(work, "freedoom.zip"));
    const extract = join(work, "release");
    mkdirSync(extract, { recursive: true });
    unzip(zip, "freedoom1.wad", extract);
    wadPath = join(extract, "freedoom1.wad");
    console.log("  using the official Freedoom release");
  } catch (error) {
    console.warn(`  official release unavailable (${error.message.split("\n")[0]}), trying the npm mirror`);
    const tgz = download(NPM_FALLBACK, join(work, "kaboom.tgz"));
    const extract = join(work, "npm");
    mkdirSync(extract, { recursive: true });
    execFileSync("tar", ["xzf", tgz, "-C", extract], { stdio: ["ignore", "inherit", "inherit"] });
    wadPath = join(extract, "package/engine/freedoom1.wad");
    if (!existsSync(wadPath)) throw new Error("neither source produced a freedoom1.wad");
    console.log("  using the npm mirror of the same Freedoom release");
  }
}

const size = validate(wadPath);
console.log(`  IWAD ok: ${size} bytes`);

console.log("compressing with gzip -9…");
const start = Date.now();
const raw = readFileSync(wadPath);
const gz = gzipSync(raw, { level: 9 });
writeFileSync(target, gz);
console.log(
  `  ${(size / 1048576).toFixed(1)} MiB -> ${(gz.length / 1048576).toFixed(2)} MiB ` +
    `(${(size / gz.length).toFixed(2)}:1) in ${Date.now() - start} ms`,
);

const sha = createHash("sha256").update(gz).digest("hex");
writeFileSync(`${target}.sha256`, `${sha}  freedoom1.wad.gz\n`);
console.log(`  sha256 ${sha}`);
console.log(`wrote ${target}`);

// Keep the licence text next to the data it covers.
for (const [name, url] of [
  ["FREEDOOM-COPYING.txt", "https://raw.githubusercontent.com/freedoom/freedoom/master/COPYING.adoc"],
]) {
  const destination = join(assets, name);
  if (!existsSync(destination)) {
    try {
      download(url, destination);
    } catch {
      /* the repository already ships a copy */
    }
  }
}

rmSync(work, { recursive: true, force: true });
