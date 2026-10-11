#!/usr/bin/env node
/**
 * serve.mjs - a small static server for the game.
 *
 * It exists (instead of "python -m http.server") because the game wants three
 * things from a web server:
 *
 *   * `application/wasm` for doom.wasm so the browser can stream-compile it
 *   * COOP/COEP headers, which make the page cross-origin isolated and unlock
 *     SharedArrayBuffer for the glitch-free AudioWorklet mixer; without them
 *     the game falls back to a ScriptProcessorNode and still works
 *   * the gzipped IWAD served *without* Content-Encoding: the browser
 *     decompresses it itself with DecompressionStream, so no double decoding
 *
 * Usage: node serve.mjs [--port 8000] [--root web]
 */

import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = Number(arg("port", process.env.PORT || 8000));
const HOST = arg("host", "0.0.0.0");
const ROOT = resolve(HERE, arg("root", "web"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wad": "application/octet-stream",
  ".gz": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const server = createServer((request, response) => {
  const started = Date.now();
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const target = normalize(join(ROOT, pathname));
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    response.writeHead(403).end("forbidden");
    return;
  }

  let stats;
  try {
    stats = statSync(target);
    if (stats.isDirectory()) {
      stats = statSync(join(target, "index.html"));
      pathname = join(pathname, "index.html");
    }
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${pathname}`);
    return;
  }

  const file = stats.isDirectory() ? join(target, "index.html") : target;
  const extension = extname(file).toLowerCase();
  const headers = {
    "content-type": MIME[extension] || "application/octet-stream",
    "content-length": statSync(file).size,
    "cache-control": "no-cache",
    // Cross-origin isolation: enables SharedArrayBuffer for the audio worklet.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
  };

  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(file);
  stream.pipe(response);
  stream.on("error", () => response.destroy());
  stream.on("end", () => {
    const size = statSync(file).size;
    console.log(`${String(response.statusCode)} ${request.method} ${pathname} ${(size / 1024).toFixed(0)} KiB ${Date.now() - started}ms`);
  });
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`Freedoom wasm server`);
  console.log(`  root : ${ROOT}`);
  console.log(`  url  : http://${shown}:${PORT}/`);
  console.log(`  coop : enabled (SharedArrayBuffer / AudioWorklet available)`);
});
