#!/usr/bin/env node
// Drives the MCP server over real stdio and asserts what a client would see. No dependencies —
// `node plugins/pdh-brain/server/selftest.mjs` from anywhere. Exit 0 = green.
//
// Everything here asserts observable protocol behaviour, never internals: the server is a black
// box that reads newline-delimited JSON-RPC on stdin and writes it on stdout.

import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync,
  rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { createVaultRepo, serveWithAuth } from "./fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "index.mjs");

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) return console.log(`  ok   ${label}`);
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
};

// A live server plus everything it wrote, so a test can assert on the streams themselves and not
// only on the replies. `send` resolves on the response carrying the matching id; notifications
// (no id) are fire-and-forget, exactly as the protocol defines them.
function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const state = { stdoutLines: [], stderr: "", waiters: new Map() };
  let buf = "";

  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line === "") continue;
      state.stdoutLines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = state.waiters.get(msg.id);
      if (waiter) { state.waiters.delete(msg.id); waiter(msg); }
    }
  });
  child.stderr.on("data", (chunk) => { state.stderr += chunk; });

  // A dead child must reject rather than hang: without this a missing server exits the harness
  // silently through an unsettled await, which reads as neither pass nor fail.
  let exited = null;
  child.on("error", (err) => { exited = `server failed to start: ${err.message}`; });
  child.on("exit", (code) => { exited ??= `server exited with code ${code}`; });

  let nextId = 1;
  state.send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      state.waiters.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      const timer = setTimeout(
        () => reject(new Error(exited ?? `timed out waiting for ${method}`)), 5000);
      state.waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  state.notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  state.stop = () => { child.stdin.end(); child.kill(); };
  return state;
}

const PROTOCOL_VERSION = "2026-07-28";

console.log("pdh-brain selftest");

// --- the server speaks JSON-RPC over stdio -----------------------------------------------------
try {
  const s = startServer();
  const res = await s.send("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "selftest", version: "0" },
  });
  check("initialize returns a jsonrpc 2.0 result", res.jsonrpc === "2.0" && !!res.result,
    `got ${JSON.stringify(res).slice(0, 120)}`);
  check("initialize advertises the tools capability", !!res.result?.capabilities?.tools,
    `capabilities were ${JSON.stringify(res.result?.capabilities)}`);
  check("initialize names the server", typeof res.result?.serverInfo?.name === "string",
    `serverInfo was ${JSON.stringify(res.result?.serverInfo)}`);
  s.stop();
} catch (err) {
  check("the server starts and answers initialize", false, err.message);
}

// A server that answers with its own hardcoded protocol version is refused outright by any client
// that doesn't happen to speak it — "Failed to connect — Server's protocol version is not
// supported". Negotiation means echoing the version the client asked for.
for (const requested of ["2025-06-18", "2025-11-25", "2026-07-28"]) {
  try {
    const s = startServer();
    const res = await s.send("initialize", { protocolVersion: requested, capabilities: {},
      clientInfo: { name: "selftest", version: "0" } });
    check(`initialize echoes the client's protocol version ${requested}`,
      res.result?.protocolVersion === requested, `server answered ${res.result?.protocolVersion}`);
    s.stop();
  } catch (err) {
    check(`initialize negotiates ${requested}`, false, err.message);
  }
}

// --- the tool surface is fixed -----------------------------------------------------------------
// Tool names are the permission surface: a user allowlists mcp__plugin_pdh-brain_brain__<tool>,
// and adding a name later re-prompts everyone who installed. So the full set is pinned here,
// before any of them do anything.
const EXPECTED_TOOLS = ["brain_status", "list_gaps", "read_page", "search_brain"];
try {
  const s = startServer();
  await s.send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: "selftest", version: "0" } });
  s.notify("notifications/initialized");
  const res = await s.send("tools/list", {});
  const names = (res.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list returns exactly the four tools",
    JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `got ${JSON.stringify(names)}`);
  check("every tool carries a description and an input schema",
    (res.result?.tools ?? []).every((t) => t.description && t.inputSchema?.type === "object"),
    `got ${JSON.stringify(res.result?.tools)?.slice(0, 200)}`);
  s.stop();
} catch (err) {
  check("the server answers tools/list", false, err.message);
}

// --- calling a tool, and keeping stdout clean --------------------------------------------------
// The stdout/stderr split is not cosmetic: one stray console.log corrupts the JSON-RPC stream and
// the failure surfaces as "the client is broken". This asserts the property directly.
try {
  const s = startServer();
  await s.send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: "selftest", version: "0" } });
  s.notify("notifications/initialized");
  const res = await s.send("tools/call", { name: "brain_status", arguments: {} });
  check("tools/call brain_status returns text content",
    res.result?.content?.[0]?.type === "text" && typeof res.result.content[0].text === "string",
    `got ${JSON.stringify(res).slice(0, 200)}`);
  check("an unknown tool is an error, not an empty success",
    (await s.send("tools/call", { name: "no_such_tool", arguments: {} })).error != null,
    "expected a JSON-RPC error member");

  const unparseable = s.stdoutLines.filter((l) => { try { JSON.parse(l); return false; }
    catch { return true; } });
  check("every stdout line is a JSON-RPC message", unparseable.length === 0,
    `first offender: ${unparseable[0]?.slice(0, 120)}`);
  check("the server logs to stderr", s.stderr.includes("pdh-brain"),
    `stderr was ${JSON.stringify(s.stderr.slice(0, 120))}`);
  s.stop();
} catch (err) {
  check("the server answers tools/call", false, err.message);
}

// --- the vault: authenticated, sparse, and leaving no credential behind ------------------------
const TOKEN = "fixture-token-9f3a";
const scratch = [];
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `pdh-${label}-`));
  scratch.push(d);
  return d;
};

// Records every git invocation's arguments, so a token smuggled through argv is visible. argv is
// world-readable through ps, which makes it a real leak and not a theoretical one.
function gitShim() {
  const dir = tempDir("shim");
  const log = join(dir, "argv.log");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  return { dir, log, read: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
}) : []);

const filesContaining = (dir, needle) => walk(dir).filter((p) => {
  try { return readFileSync(p, "utf8").includes(needle); } catch { return false; }
});

const callStatus = async (s) => {
  await s.send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: "selftest", version: "0" } });
  const res = await s.send("tools/call", { name: "brain_status", arguments: {} });
  return res.result?.content?.[0]?.text ?? JSON.stringify(res);
};

const repo = createVaultRepo();
const remote = await serveWithAuth({ bare: repo.bare, token: TOKEN });

try {
  // 1-4: a good token clones, scopes the checkout, and leaves no trace of itself.
  const shim = gitShim();
  const dataDir = tempDir("data");
  const s = startServer({
    PATH: `${shim.dir}:${process.env.PATH}`,
    PDH_VAULT_REPO: remote.url,
    PDH_VAULT_TOKEN: TOKEN,
    PDH_DATA_DIR: dataDir,
  });
  const status = await callStatus(s);
  s.stop();

  check("a first call clones and reports the vault's commit", status.includes(repo.head),
    `status was ${JSON.stringify(status)}, fixture head is ${repo.head}`);

  const vault = join(dataDir, "vault");
  check("the checkout contains wiki/ and CLAUDE.md",
    existsSync(join(vault, "wiki")) && existsSync(join(vault, "CLAUDE.md")),
    `vault contents: ${existsSync(vault) ? readdirSync(vault).join(", ") : "<no vault>"}`);
  check("the checkout excludes raw/ and outputs/",
    !existsSync(join(vault, "raw")) && !existsSync(join(vault, "outputs")),
    `vault contents: ${existsSync(vault) ? readdirSync(vault).join(", ") : "<no vault>"}`);

  const leaked = filesContaining(dataDir, TOKEN);
  check("the token is written to no file, including .git/config",
    leaked.length === 0, `found in: ${leaked.map((p) => p.replace(dataDir, "")).join(", ")}`);
  check("the token appears in no tool response", !status.includes(TOKEN));
  check("the token appears in no log line", !s.stderr.includes(TOKEN));
  // Assert the shim actually saw git first: "the log contains no token" is vacuously true of an
  // empty log, which is exactly what a broken shim produces.
  const invocations = shim.read().split("\n").filter(Boolean);
  check("the git shim observed the clone", invocations.some((l) => l.startsWith("clone")),
    `argv log had ${invocations.length} invocation(s): ${invocations.join(" / ").slice(0, 120)}`);
  check("the token appears in no git command line", !shim.read().includes(TOKEN),
    `argv log: ${invocations.join(" / ").slice(0, 160)}`);

  // 5: a rejected credential refuses in terms the user can act on, and does not hang.
  const bad = startServer({
    PDH_VAULT_REPO: remote.url, PDH_VAULT_TOKEN: "wrong-token", PDH_DATA_DIR: tempDir("data"),
  });
  const badStatus = await callStatus(bad);
  bad.stop();
  check("a rejected token says so, rather than hanging or blaming the network",
    /token was rejected|expired|revoked/i.test(badStatus), `status was ${JSON.stringify(badStatus)}`);

  // 6: an absent credential names the setting to fill in, not a git error.
  const none = startServer({
    PDH_VAULT_REPO: remote.url, PDH_VAULT_TOKEN: "", PDH_DATA_DIR: tempDir("data"),
  });
  const noneStatus = await callStatus(none);
  none.stop();
  check("a missing token names the setting to fill in", noneStatus.includes("vault_token"),
    `status was ${JSON.stringify(noneStatus)}`);

  // 7: unreachable with nothing cached is a refusal, never an empty answer.
  await remote.close();
  const offline = startServer({
    PDH_VAULT_REPO: remote.url, PDH_VAULT_TOKEN: TOKEN, PDH_DATA_DIR: tempDir("data"),
  });
  await offline.send("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {},
    clientInfo: { name: "selftest", version: "0" } });
  const searchRes = await offline.send("tools/call",
    { name: "search_brain", arguments: { query: "anything" } });
  const searchText = searchRes.result?.content?.[0]?.text ?? "";
  offline.stop();
  check("an unreachable vault with no local copy refuses rather than returning nothing",
    /could not be reached/i.test(searchText) && searchText.length > 0,
    `search_brain said ${JSON.stringify(searchText)}`);
} catch (err) {
  check("the vault syncs against the fixture", false, err.stack ?? err.message);
} finally {
  try { await remote.close(); } catch {}
  repo.cleanup();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nclean — 0 failures" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
