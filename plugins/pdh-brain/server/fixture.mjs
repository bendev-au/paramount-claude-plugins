#!/usr/bin/env node
// Test scaffolding for the selftest: a throwaway git repository served over HTTP that demands a
// bearer credential. Used only by selftest.mjs.
//
// A file:// remote would let the sync tests pass without ever exercising authentication, which is
// the one thing slice 2 exists to get right. So this serves the real git smart-HTTP protocol via
// `git http-backend` and rejects anything without the expected Authorization header — the same
// 401 a private GitHub repo returns to a caller with no token.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" },
  });

// A miniature of the real vault: the directories the sparse checkout must include and exclude,
// and enough page shape for retrieval tests later.
export function createVaultRepo() {
  const root = mkdtempSync(join(tmpdir(), "pdh-fixture-"));
  const work = join(root, "work");
  mkdirSync(join(work, "wiki", "concepts"), { recursive: true });
  mkdirSync(join(work, "raw", "sources"), { recursive: true });
  mkdirSync(join(work, "outputs"), { recursive: true });

  writeFileSync(join(work, "CLAUDE.md"), "# Fixture vault\n\n## Query\n\nAnswer with citations.\n");
  writeFileSync(join(work, "wiki", "concepts", "example-page.md"),
    "---\ntitle: Example Page\naliases:\n  - Example Page\ntype: concept\ntags:\n  - type/concept\n" +
    "summary: A page that exists so the sync tests have something to find.\nupdated: 2026-08-13\n" +
    "status: current\n---\n\n# Example Page\n\nBody text mentioning a Fixture Term.\n");
  writeFileSync(join(work, "raw", "sources", "confidential.md"),
    "This file must never reach a staff machine. Its presence in a checkout is a test failure.\n");
  writeFileSync(join(work, "outputs", "report.md"), "Generated output, also excluded.\n");

  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "Fixture vault");
  const head = git(work, "rev-parse", "--short", "HEAD").trim();

  const bare = join(root, "vault.git");
  git(root, "clone", "-q", "--bare", work, bare);
  // http-backend refuses to serve a repo whose objects were never packed for dumb clients unless
  // this is set; it also needs the repo marked exportable.
  git(bare, "config", "http.receivepack", "false");
  writeFileSync(join(bare, "git-daemon-export-ok"), "");
  return { root, bare, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Serves `bare` over git smart-HTTP, but only to callers presenting exactly `token`. Anything else
// gets a 401 — the same shape a private repo returns when the credential is wrong or absent.
export function serveWithAuth({ bare, token }) {
  const debug = !!process.env.PDH_FIXTURE_DEBUG;
  const server = createServer((req, res) => {
    if (debug) {
      process.stderr.write(`[fixture] ${req.method} ${req.url}\n`);
      for (const [k, v] of Object.entries(req.headers)) {
        process.stderr.write(`[fixture]   ${k}: ${k === "authorization" ? "<redacted>" : v}\n`);
      }
      res.on("finish", () => process.stderr.write(`[fixture] -> ${res.statusCode} finished\n`));
      res.on("close", () => process.stderr.write(`[fixture] -> connection closed\n`));
    }
    const auth = req.headers.authorization ?? "";
    const expected = "Basic " + Buffer.from(`x-access-token:${token}`).toString("base64");
    if (auth !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      return res.end("bad credentials\n");
    }

    const [pathInfo, query = ""] = req.url.split("?");
    // Buffer the body rather than streaming it. git posts its negotiation with chunked transfer
    // encoding and therefore no Content-Length, and http-backend blocks forever reading stdin
    // when CONTENT_LENGTH is absent or empty. These bodies are a few KB.
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const backend = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH,
          // The directory *containing* the repo — PATH_INFO already carries the repo name, so
          // pointing this at the repo itself makes http-backend look for vault.git/vault.git.
          GIT_PROJECT_ROOT: dirname(bare),
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: pathInfo,
          QUERY_STRING: query,
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          ...(req.headers["content-encoding"]
            ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
        },
      });
      backend.stdin.end(body);
      wire(backend);
    });

    function wire(backend) {

    // http-backend speaks CGI: headers, blank line, body. Translate that into an HTTP response.
    let head = Buffer.alloc(0);
    let sentHeaders = false;
    backend.stdout.on("data", (chunk) => {
      if (sentHeaders) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const split = head.indexOf("\r\n\r\n");
      if (split === -1) return;
      const headers = {};
      for (const line of head.slice(0, split).toString().split("\r\n")) {
        const at = line.indexOf(":");
        if (at > 0) headers[line.slice(0, at)] = line.slice(at + 1).trim();
      }
      const status = Number(headers.Status?.split(" ")[0] ?? 200);
      delete headers.Status;
      sentHeaders = true;
      res.writeHead(status, headers);
      res.write(head.slice(split + 4));
    });
    backend.stdout.on("end", () => res.end());
    backend.stderr.on("data", () => {});
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/vault.git`,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
