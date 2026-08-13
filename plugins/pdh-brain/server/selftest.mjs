#!/usr/bin/env node
// Drives the MCP server over real stdio and asserts what a client would see. No dependencies —
// `node plugins/pdh-brain/server/selftest.mjs` from anywhere. Exit 0 = green.
//
// Everything here asserts observable protocol behaviour, never internals: the server is a black
// box that reads newline-delimited JSON-RPC on stdin and writes it on stdout.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

console.log(failures === 0 ? "\nclean — 0 failures" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
