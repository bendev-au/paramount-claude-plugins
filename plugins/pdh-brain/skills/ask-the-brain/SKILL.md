---
name: ask-the-brain
description: Answer a question from Paramount's company knowledge base — SDA, SIL, MTA, leasing, tenancy, uplift, enrolment, property management, or anything about how Paramount actually operates. Use whenever a question concerns Paramount's own processes, policies, roles or systems rather than general knowledge, and whenever someone asks what the company does about something.
---

# Ask the brain

The knowledge base is a wiki of Paramount's own process, policy and role knowledge. It is the
authority on how the company operates. Your general knowledge of the NDIS and SDA is not, and is
frequently wrong about Paramount specifically.

## How to answer

1. **`brain_status`** if currency could matter — anything about a current process, a live
   arrangement, or what happens today. If it reports `STALE`, say so in your answer.
2. **`search_brain`** with the person's own words. It returns matching pages *and* the full
   catalogue of every page. When the keyword matches look wrong or thin, choose from the
   catalogue instead — the right page is often one whose summary covers the topic under
   different words.
3. **`read_page`** every page you intend to cite. Never answer from a search result line alone:
   those are summaries, and the answer usually lives in the body.
4. **Answer**, following the rules the server supplied in its instructions. Those rules come from
   the knowledge base itself — this skill does not restate them, so there is nothing here to drift
   out of step with them.

## When the brain does not cover it

Say so plainly. Then call **`list_gaps`** — the wiki records what it knows it is missing, and a
question that matches a known gap deserves "this is a known gap" rather than a guess.

Do not fill a gap from general NDIS or SDA knowledge. A confident wrong answer about Paramount's
own process is worse than no answer, because the person cannot tell it apart from a right one.

## What this cannot do

Read-only. There is no way to add or edit a page from here — that happens in the knowledge base's
own repository, where linting gates it. If something durable comes out of a conversation, say it
is worth filing and leave it there.
