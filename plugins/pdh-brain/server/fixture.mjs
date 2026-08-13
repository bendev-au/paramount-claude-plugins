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

  writeFileSync(join(work, "CLAUDE.md"),
    "# Fixture vault\n\n## Query\n\n1. Start from the catalogue.\n\n### Answer rules\n\n" +
    "<!-- answer-rules:start -->\n- Answer with `[[wikilink]]` citations.\n" +
    "- When the wiki is thin on a topic, say so.\n<!-- answer-rules:end -->\n");

  // The fixture reproduces the real vault's *shapes*, not its content — this repository is public.
  // Each page below exists to exercise one retrieval property.
  const page = (dir, slug, front, body) =>
    writeFileSync(join(work, "wiki", dir, `${slug}.md`), `---\n${front}\n---\n\n${body}\n`);
  mkdirSync(join(work, "wiki", "processes"), { recursive: true });

  page("concepts", "example-page",
    "title: Example Page\naliases:\n  - Example Page\ntype: concept\ntags:\n  - type/concept\n" +
    "summary: A page that exists so the sync tests have something to find.\n" +
    "updated: 2026-08-13\nstatus: current",
    "# Example Page\n\nBody text mentioning a Fixture Term.");

  // Owns the definition, and says the term plainly on one line.
  page("concepts", "glossary",
    "title: Glossary\naliases:\n  - Glossary\ntype: concept\ntags:\n  - type/concept\n" +
    "summary: Short definitions of the acronyms used across the wiki.\n" +
    "updated: 2026-08-13\nstatus: current",
    "# Glossary\n\n| Term | Meaning |\n|---|---|\n" +
    "| **BSP** | Behaviour Support Plan. Invented gloss; this fixture carries no wiki text. |");

  // The critical one: the term is split across a line break, so a line-based scan misses it and
  // only whitespace-normalised matching finds it. This is the real vault's own recall bug.
  page("concepts", "restraint-review",
    "title: Restraint Review\naliases:\n  - Restraint Review\ntype: concept\n" +
    "tags:\n  - type/concept\nsummary: When an environmental restraint has to be reviewed.\n" +
    "updated: 2026-08-13\nstatus: current",
    // The wrap is the point: the term straddles a newline, so a line-based scan misses it.
    "# Restraint Review\n\nFixture sentence one, padded so the phrase falls across a\n" +
    "line break: Behaviour Support\nPlan appears split here on purpose.");

  page("processes", "tenancy-matching",
    "title: Tenancy Matching\naliases:\n  - Tenancy Matching\ntype: process\n" +
    "tags:\n  - type/process\nsummary: Matching a participant to a vacancy.\n" +
    "updated: 2026-08-13\nstatus: current",
    "# Tenancy Matching\n\nAsk whether a Behaviour Support Plan exists before a meet and greet.");

  page("processes", "legacy-matching",
    "title: Legacy Matching\naliases:\n  - Legacy Matching\ntype: process\n" +
    "tags:\n  - type/process\nsummary: The retired matching process, kept for history.\n" +
    "updated: 2026-01-01\nstatus: superseded",
    "# Legacy Matching\n\nThe old flow also referenced a Behaviour Support Plan.");

  // Frontmatter that does not parse: it must be skipped, not fatal.
  writeFileSync(join(work, "wiki", "concepts", "broken.md"),
    "---\ntitle: Broken\n  this is not: valid: yaml: at all\n\n# Broken\n\nBehaviour Support Plan.\n");

  // The unowned-term register really does sit inside a callout, so the table rows are prefixed.
  writeFileSync(join(work, "wiki", "gaps.md"),
    "---\ntitle: Known Gaps\naliases:\n  - Known Gaps\ntype: gaps\ntags:\n  - type/gaps\n" +
    "summary: What the wiki does not cover yet.\nupdated: 2026-08-13\nstatus: current\n---\n\n" +
    "# Known Gaps\n\n> [!todo] Unowned recurring terms\n> | Term | Pages | Resolution |\n" +
    "> |---|---|---|\n> | **Behaviour Support Plan** | 16 | A concept page. |\n" +
    "> | **Support Coordinator** | 12 | Needs its own page. |\n");
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
