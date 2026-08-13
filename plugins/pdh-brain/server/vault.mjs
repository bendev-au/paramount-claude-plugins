// Keeps a local copy of the private wiki and answers "is it usable, and how current is it".
//
// Two properties drive every decision here:
//
//   The token never lands anywhere durable. Not in the remote URL (git persists that into
//   .git/config), not in a command line (argv is world-readable via ps), not in a log line. It
//   travels in the environment and reaches git through an askpass helper that holds no secret
//   itself.
//
//   The checkout is sparse. Only wiki/ and the root files are ever written to disk, so raw/ —
//   un-editorialised source material — never reaches a staff machine at all, whatever the server
//   does or does not choose to serve.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, chmodSync,
  statSync } from "node:fs";
import { join } from "node:path";

const pexec = promisify(execFile);

export const STATE_VERSION = 1;

// A query inside this window reads the existing checkout with no network call at all. It sets how
// long a legitimately offline user waits before the staleness marker appears.
export const THROTTLE_MS = 15 * 60 * 1000;
// A sync killed mid-fetch — force quit, sleep, OOM — leaves its lock behind. Past this age the
// lock is ignored, so a dead process degrades to "no sync" rather than wedging the server.
export const LOCK_STALE_MS = 5 * 60 * 1000;

// Named so a failure tells the user which setting to fix, not which git command failed.
export const REASONS = {
  NO_TOKEN: "no-token",
  NO_REPO: "no-repo",
  AUTH: "auth",
  UNREACHABLE: "unreachable",
};

export const paths = (dataDir) => ({
  vault: join(dataDir, "vault"),
  state: join(dataDir, "state.json"),
  lock: join(dataDir, "sync.lock"),
  askpass: join(dataDir, "askpass.sh"),
});

const remoteUrl = (repo) => {
  // A full URL is used by the tests' local fixture; owner/name is the real case.
  const base = repo.includes("://") ? repo : `https://github.com/${repo}.git`;
  // Username only. The password comes from askpass, so no secret is ever written into .git/config.
  return base.replace("://", "://x-access-token@");
};

// Holds no secret: it echoes an environment variable that git's own child process already has.
function writeAskpass(dataDir) {
  const { askpass } = paths(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(askpass, "#!/bin/sh\nprintf '%s' \"$PDH_VAULT_TOKEN\"\n");
  chmodSync(askpass, 0o700);
  return askpass;
}

async function git(args, { cwd, token, dataDir }) {
  const askpass = writeAskpass(dataDir);
  return pexec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_ASKPASS: askpass,
      PDH_VAULT_TOKEN: token,
      // Without this a missing or wrong credential blocks on a prompt no one can answer, and the
      // server hangs instead of reporting.
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
}

const classify = (err) => {
  const text = `${err.stderr ?? ""}${err.stdout ?? ""}`;
  return /authentication failed|could not read Username|403|401|not found/i.test(text)
    ? REASONS.AUTH
    : REASONS.UNREACHABLE;
};

export function readState(dataDir) {
  const { state } = paths(dataDir);
  if (!existsSync(state)) return null;
  try {
    const parsed = JSON.parse(readFileSync(state, "utf8"));
    // An unrecognised shape is treated as no previous sync — a re-clone, never a misread.
    return parsed?.stateVersion === STATE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

const writeState = (dataDir, head) =>
  writeFileSync(paths(dataDir).state,
    JSON.stringify({ stateVersion: STATE_VERSION, lastSync: Date.now(), head }, null, 2));

async function cloneVault({ repo, token, dataDir }) {
  const { vault } = paths(dataDir);
  const staging = `${vault}.incoming`;
  rmSync(staging, { recursive: true, force: true });
  // Clone into staging and rename, so an interrupted clone never leaves a half-built vault/ that
  // a later call would mistake for a good one.
  await git(["clone", "--filter=blob:none", "--sparse", "--depth", "1", remoteUrl(repo), staging],
    { token, dataDir });
  // Cone mode already checks out root-level files, so CLAUDE.md arrives without being listed —
  // and listing it fails outright: "fatal: 'CLAUDE.md' is not a directory".
  await git(["sparse-checkout", "set", "wiki"], { cwd: staging, token, dataDir });
  rmSync(vault, { recursive: true, force: true });
  renameSync(staging, vault);
}

// Advisory and non-blocking by design: a caller that cannot take the lock serves what it already
// has instead of waiting. Nothing here ever blocks a query on another process.
function takeLock(dataDir) {
  const { lock } = paths(dataDir);
  if (existsSync(lock)) {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < LOCK_STALE_MS) return false;
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(lock, String(process.pid));
  return true;
}
const dropLock = (dataDir) => rmSync(paths(dataDir).lock, { force: true });

// Never `git pull`: a rebase or force-push on the default branch breaks a shallow pull
// permanently, and the failure policy would then age every machine into refusal for a reason
// nobody could see.
async function fetchVault({ repo, token, dataDir }) {
  const { vault } = paths(dataDir);
  await git(["fetch", "--depth", "1", remoteUrl(repo), "HEAD"], { cwd: vault, token, dataDir });
  await git(["reset", "--hard", "FETCH_HEAD"], { cwd: vault, token, dataDir });
}

export async function head(dataDir) {
  const { vault } = paths(dataDir);
  if (!existsSync(vault)) return null;
  const { stdout } = await pexec("git", ["rev-parse", "--short", "HEAD"], { cwd: vault });
  return stdout.trim();
}

// The single entry point. Returns a usable vault, or a refusal that says what to do about it —
// never an empty result, because "the brain holds nothing" and "the brain is unreachable" read
// identically to a user and only one of them is a reason to look elsewhere.
export async function ensureVault({ repo, token, dataDir }) {
  if (!token) {
    return { ok: false, reason: REASONS.NO_TOKEN,
      message: "No access token is configured. Set the plugin's \"Read-only access token\" " +
        "(vault_token) to the token you were given." };
  }
  if (!repo) {
    return { ok: false, reason: REASONS.NO_REPO,
      message: "No knowledge base repository is configured. Set the plugin's " +
        "\"Knowledge base repository\" (vault_repo) to the owner/name you were given." };
  }

  const { vault } = paths(dataDir);
  const haveVault = existsSync(vault);

  if (!haveVault) {
    try {
      await cloneVault({ repo, token, dataDir });
    } catch (err) {
      const reason = classify(err);
      return { ok: false, reason,
        message: reason === REASONS.AUTH
          ? "The access token was rejected. It may have expired, been revoked, or lack read " +
            "access to that repository."
          : "The knowledge base could not be reached, and no local copy exists on this machine " +
            "yet, so there is nothing to fall back to." };
    }
    const at = await head(dataDir);
    writeState(dataDir, at);
    return { ok: true, head: at, vaultPath: vault, fresh: true };
  }

  const state = readState(dataDir);
  const age = state ? Date.now() - state.lastSync : Infinity;

  // Inside the window, or unable to take the lock, serve what is already on disk untouched.
  if (age < THROTTLE_MS || !takeLock(dataDir)) {
    return { ok: true, head: await head(dataDir), vaultPath: vault, fresh: age < THROTTLE_MS };
  }

  try {
    await fetchVault({ repo, token, dataDir });
    const at = await head(dataDir);
    writeState(dataDir, at);
    return { ok: true, head: at, vaultPath: vault, fresh: true };
  } catch (err) {
    return { ok: true, head: await head(dataDir), vaultPath: vault, fresh: false,
      syncFailed: classify(err), ageMs: age };
  } finally {
    dropLock(dataDir);
  }
}
