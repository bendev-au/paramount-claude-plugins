# paramount-skills

Shared skills for Paramount work. Each skill is a repeatable procedure that any repo can use.

## Install

```
/plugin marketplace add bendev-au/paramount-claude-plugins
/plugin install paramount-skills@paramount
```

No credentials are needed. The plugin runs no server.

## Skills

| Skill | What it does |
|---|---|
| `write-email` | Draft an email to a stakeholder, a participant or family, or a trade or supplier. |
| `humanize` | Rewrite a draft so it reads as if a person wrote it. `write-email` calls it on every draft. |

## Add a skill

1. Create `skills/<skill-name>/SKILL.md`.
2. Give it YAML frontmatter with `name` and `description`. The `description` decides when Claude
   picks the skill, so write it as the trigger: what the task is, and the words a person uses for it.
3. Write the procedure in the body. Keep it short. Point at files and commands instead of
   restating them.
4. Add a row to the table above.
5. Commit and push. Users get it with `/plugin marketplace update paramount`.

## What must not go in here

This repository is public. A skill body must hold no company knowledge — no process detail that
is confidential, no names, no rates, no client or tenant data. Put that knowledge in the wiki and
let the skill point at it through `pdh-brain`.
