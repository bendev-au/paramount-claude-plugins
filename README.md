# paramount-claude-plugins

Claude Code plugins for Paramount Disability Homes.

This repository is public and contains **no company knowledge**. Plugins here read private
data sources using credentials you supply at install time; nothing confidential is committed.

## Plugins

| Plugin | What it does |
|---|---|
| `pdh-brain` | Ask the company knowledge base a question from any repo, and get answers cited back to real wiki pages. |

## Install

```
/plugin marketplace add bendev-au/paramount-claude-plugins
/plugin install pdh-brain@paramount
```

No GitHub login is required to install. See the plugin's own README for the one credential it
does need and how to obtain it.
