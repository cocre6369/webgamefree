#!/usr/bin/env node
/**
 * play-link.mjs - print the links that let somebody else play this game.
 *
 * Two kinds of link, for two situations:
 *
 *   1. GitHub Pages - the proper one.  https://<owner>.github.io/<repo>/
 *      Needs Pages switched on once (Settings -> Pages -> Source: GitHub
 *      Actions); .github/workflows/pages.yml then publishes web/ on every push.
 *
 *   2. jsDelivr - works instantly, with no repository settings at all.  It
 *      serves the files straight out of this repository over a CDN (correct
 *      MIME types, CORS).  The URL is pinned to a commit, so it keeps working
 *      even after the branch moves, and it is the link to hand out while Pages
 *      is still being switched on.
 *
 * Usage:
 *   node tools/play-link.mjs              # human readable
 *   node tools/play-link.mjs --json       # machine readable
 *   node tools/play-link.mjs --check      # also fetch the pages URL (needs network)
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** owner/repo from the origin remote (https or ssh). */
function repoSlug() {
  const remote = git("remote", "get-url", "origin");
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot work out owner/repo from remote: ${remote}`);
  return { owner: match[1], repo: match[2] };
}

const { owner, repo } = repoSlug();
const sha = git("rev-parse", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const shortSha = sha.slice(0, 10);

const pages = `https://${owner.toLowerCase()}.github.io/${repo}/`;
// Point at index.html explicitly: a directory URL returns a listing page.
const cdnPinned = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${sha}/web/index.html`;
const cdnBranch = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch.replace(/\//g, "%2F")}/web/index.html`;
const repoUrl = `https://github.com/${owner}/${repo}`;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ pages, cdn: cdnPinned, repo: repoUrl, branch, commit: sha }, null, 2));
  process.exit(0);
}

console.log(`\n  FREEDOOM / DOOM in the browser - play links\n`);
console.log(`  GitHub Pages (permanent, needs Pages enabled once):`);
console.log(`    ${pages}`);
console.log(`\n  jsDelivr CDN (works right now, no settings required):`);
console.log(`    ${cdnPinned}`);
console.log(`\n  repository:`);
console.log(`    ${repoUrl}  (branch ${branch}, commit ${shortSha})`);
console.log(`\n  To make the Pages link live: Settings -> Pages -> Source "GitHub Actions".`);
console.log(`  The workflow re-runs on every push, and every 20 minutes until it succeeds.\n`);
console.log(`  Branch form of the CDN link (not recommended - pin the commit instead):`);
console.log(`    ${cdnBranch}\n`);

if (process.argv.includes("--check")) {
  for (const [label, url] of [["pages", pages], ["cdn", cdnPinned]]) {
    try {
      const response = await fetch(url, { method: "GET" });
      console.log(`  ${label.padEnd(6)} ${response.status} ${response.statusText} ${url}`);
    } catch (error) {
      console.log(`  ${label.padEnd(6)} unreachable from here (${error.message}) - try it in a browser`);
    }
  }
}
