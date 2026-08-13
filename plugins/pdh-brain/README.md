# pdh-brain

Ask the company knowledge base a question from any repository, and get an answer cited back to
real wiki pages — or a straight admission that the wiki does not cover it.

## Install

Three steps. **No GitHub login is required**, and you do not need to clone anything.

```
/plugin marketplace add bendev-au/paramount-claude-plugins
/plugin install pdh-brain@paramount
```

Then set two values when Claude Code prompts you:

| Setting | What to put in it |
|---|---|
| **Knowledge base repository** | The `owner/name` you were given. |
| **Read-only access token** | The access token you were given. It is stored in your system keychain, not in a file. |

Both travel together — ask whoever runs the knowledge base for them. Neither is in this
repository, deliberately: this repo is public.

The first question you ask will prompt you to approve the plugin's tools. That prompt is expected
on first use, and approving it once is enough.

## Minting the token, if you are the one handing them out

A **fine-grained personal access token**, scoped to the knowledge base repository only, with
**Contents: Read-only** and nothing else. Give it an expiry you are willing to diarise — when it
lapses, every machine using it stops answering after seven days, and the message says the token
was rejected.

One token shared across staff cannot attribute a read to a person, and rotating it means
redistributing to everyone at once. Per-person tokens fix both and cost more administration.

## How it behaves

- It keeps a **sparse, shallow copy** of the wiki only — `wiki/` and top-level files. Source
  material under `raw/` is never downloaded to your machine.
- It refetches at most every **15 minutes**. In between, questions are answered from the local
  copy with no network call.
- If it cannot reach the repository it keeps answering for up to **7 days**, saying how stale it
  is each time. Past 7 days it stops answering rather than serving old process silently.
- It is **read-only**. There is no way to add or edit a page from here.

## Removing it

```
/plugin uninstall pdh-brain@paramount
```

Claude Code asks before deleting the plugin's data directory. If you decline, **the downloaded
copy of the wiki stays on your disk** — removing the plugin is not the same as removing the
content. Say yes, or delete the directory yourself.

## Development

`claude --plugin-dir plugins/pdh-brain` loads the plugin without installing it, but there is no
configuration prompt on that path, so set `PDH_VAULT_REPO_DEV` and `PDH_VAULT_TOKEN_DEV` in your
environment instead. They are read only when the real settings are empty.

Run the test suite with `node plugins/pdh-brain/server/selftest.mjs`. It has no dependencies and
needs no credentials — it serves a throwaway git repository over authenticated HTTP and drives the
server over real stdio.
