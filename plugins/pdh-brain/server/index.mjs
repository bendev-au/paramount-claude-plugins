#!/usr/bin/env node
// MCP server for the Paramount company brain. Speaks newline-delimited JSON-RPC 2.0 on stdio.
//
// stdout carries protocol messages and nothing else — any stray write corrupts the stream, so
// every diagnostic goes to stderr. The selftest asserts this, because it is the failure that
// looks like the client is broken rather than the server.

import { homedir } from "node:os";
import { join } from "node:path";
import { ensureVault } from "./vault.mjs";

// Echo back whatever protocol version the client asked for. This server uses only initialize,
// tools/list and tools/call, which every revision defines identically, so there is nothing to
// negotiate down to. Answering with a version of our own choosing instead gets the connection
// refused outright — "Server's protocol version is not supported" — by any client on a different
// revision, which is a total failure for a compatibility claim we cannot actually make.
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "pdh-brain", version: "0.1.0" };

// The tool set is fixed at v0.1.0 and additions are breaking in practice: each name is what a
// user allowlists, so a new one re-prompts everybody who already installed. Add capability to an
// existing tool's arguments before adding a tool.
const TOOLS = [
  {
    name: "brain_status",
    description:
      "Report whether the local copy of the company brain is fresh, how old it is, and which " +
      "commit it is at. Call this first when an answer's currency matters.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_brain",
    description:
      "Search the company wiki for a term or question. Returns matching pages with the line each " +
      "match starts on, alongside the full page catalogue so you can select semantically.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for. Plain language is fine." },
        limit: { type: "number", description: "Maximum pages to return. Defaults to 8." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description:
      "Read one wiki page in full by its slug, as returned by search_brain — for example " +
      "'sda-funding-uplift'. Slugs are kebab-case filenames, never paths.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Kebab-case page slug." } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_gaps",
    description:
      "List what the company brain knows it does not cover yet. Use this when a search comes " +
      "back empty, to tell the difference between 'not written down' and 'not found'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const log = (...args) => console.error("[pdh-brain]", ...args);
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
const text = (s) => ({ content: [{ type: "text", text: s }] });

const config = () => ({
  repo: process.env.PDH_VAULT_REPO,
  token: process.env.PDH_VAULT_TOKEN,
  dataDir: process.env.PDH_DATA_DIR || join(homedir(), ".pdh-brain"),
});

async function callTool(name, args) {
  if (name !== "brain_status" && !TOOLS.some((t) => t.name === name)) return null;

  const vault = await ensureVault(config());

  if (name === "brain_status") {
    return text(vault.ok
      ? `The company brain is available at commit ${vault.head}.`
      : `Unavailable — ${vault.message}`);
  }
  // A refusal, never an empty result: a reader cannot tell "the brain does not cover this" from
  // "the brain is not reachable", and only one of those means go and look somewhere else.
  if (!vault.ok) return text(`Cannot answer from the company brain — ${vault.message}`);

  switch (name) {
    case "search_brain":
    case "read_page":
    case "list_gaps":
      return text(`Retrieval lands in the next slice. The vault is synced at ${vault.head}.`);
    default:
      return null;
  }
}

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "tools/list":
      return reply(msg.id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params ?? {};
      const result = await callTool(name, args);
      if (result === null) return fail(msg.id, -32602, `unknown tool: ${name}`);
      return reply(msg.id, result);
    }
    default:
      // Notifications carry no id and want no reply; an unknown request does.
      if (msg.id !== undefined) fail(msg.id, -32601, `unknown method: ${msg.method}`);
      return;
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("ignoring unparseable line");
      continue;
    }
    await handle(msg);
  }
});

log("listening on stdio");
