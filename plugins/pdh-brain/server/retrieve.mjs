// Reads the wiki and answers questions about it.
//
// The design point is recall. The company's other retrieval path selects pages from
// `title — summary` lines alone and never sees page bodies, so a fact stated only in a body is
// unanswerable there. This one reads bodies — and returns the whole catalogue alongside the hits,
// so the model can still select semantically over every page when the keywords miss.
//
// Matching is whitespace-normalised because the wiki is hand-wrapped prose: a term can straddle a
// line break, and a line-based scan silently misses it. That is not hypothetical — it is the exact
// shape that made a term appear in fewer pages than it really occurs in.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";

export const SLUG = /^[a-z0-9-]+$/;

const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
}) : []);

// Deliberately the same minimal YAML subset the vault's own scripts parse: `key: scalar`,
// `key: [a, b]`, and block lists. The plugin cannot import them — different repository — so this
// is a copy, kept small on purpose.
function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const out = {};
  let key = null;
  for (const raw of text.slice(3, end).split("\n")) {
    if (!raw.trim()) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && key) { (out[key] ||= []).push(unquote(item[1])); continue; }
    const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    if (v === "") out[key] = [];
    else if (v.startsWith("[") && v.endsWith("]"))
      out[key] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
    else out[key] = unquote(v);
  }
  return out;
}
const unquote = (s) => s.replace(/^["'](.*)["']$/, "$1");
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ");

const NAV = new Set(["index", "gaps", "log"]);

export function loadPages(vaultPath) {
  const wiki = join(vaultPath, "wiki");
  const pages = [];
  for (const abs of walk(wiki)) {
    const slug = basename(abs, ".md");
    if (NAV.has(slug)) continue;
    const text = readFileSync(abs, "utf8");
    const fm = parseFrontmatter(text);
    // A page whose frontmatter does not parse is skipped, never fatal: one malformed file must
    // not take retrieval down for the whole vault.
    if (!fm?.title) continue;
    const body = text.slice(text.indexOf("\n---", 3) + 4);
    pages.push({
      slug,
      rel: relative(vaultPath, abs),
      title: fm.title,
      summary: fm.summary ?? "",
      status: fm.status ?? "current",
      aliases: arr(fm.aliases),
      tags: arr(fm.tags),
      body,
      lines: body.split("\n"),
    });
  }
  return pages.sort((a, b) => a.slug.localeCompare(b.slug));
}

// Line numbers are reported against the whole file, so a citation can be opened directly. A match
// that straddles a wrap is reported at the line it starts on.
function bodyMatches(page, needle) {
  const hits = [];
  const flat = norm(page.body);
  if (!flat.includes(needle)) return hits;
  // Walk a normalised sliding window so a term split across lines still resolves to a start line.
  for (let i = 0; i < page.lines.length; i++) {
    const window = norm(page.lines.slice(i, i + 3).join(" "));
    if (window.includes(needle)) {
      const already = hits.some((h) => h >= i - 2 && h <= i);
      if (!already) hits.push(i);
    }
  }
  return hits.map((i) => i + 1);
}

export function search(pages, query, limit = 8) {
  const needle = norm(query);
  if (!needle) return { results: [], catalogue: catalogue(pages) };

  const scored = [];
  for (const page of pages) {
    const inTitle = norm(page.title).includes(needle);
    const inAlias = page.aliases.some((a) => norm(a).includes(needle));
    const inTags = page.tags.some((t) => norm(t).includes(needle));
    const inSummary = norm(page.summary).includes(needle);
    const lines = bodyMatches(page, needle);
    const score = (inTitle || inAlias ? 3 : 0) + (inTags ? 1 : 0) + (inSummary ? 2 : 0) +
      (lines.length ? 1 : 0);
    if (score > 0) scored.push({ page, score, lines });
  }

  scored.sort((a, b) => b.score - a.score || a.page.slug.localeCompare(b.page.slug));
  return {
    results: scored.slice(0, limit).map(({ page, score, lines }) => ({
      slug: page.slug,
      title: page.title,
      summary: page.summary,
      status: page.status,
      path: page.rel,
      lines,
      score,
    })),
    catalogue: catalogue(pages),
  };
}

// Every page's retrieval line. Returned with every search so a keyword miss does not become "the
// brain does not cover this" — the model can still choose from the full catalogue.
export const catalogue = (pages) =>
  pages.map((p) => `${p.slug} — ${p.title} — ${p.summary}`);

export function readPage(pages, slug) {
  // A slug, never a path. Rejecting the shape rather than checking whether a file happens to
  // exist means `../CLAUDE.md` fails the same way whether or not it is present on disk.
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    return { error: `"${slug}" is not a page slug. Slugs are kebab-case names such as ` +
      `"tenancy-matching" — never paths, and never with an extension.` };
  }
  const page = pages.find((p) => p.slug === slug);
  if (!page) return { error: `No page named "${slug}". Use search_brain to find the right slug.` };
  return { page };
}

// The register lives inside an Obsidian callout, so its table rows arrive prefixed with "> ".
export function listGaps(vaultPath) {
  const file = join(vaultPath, "wiki", "gaps.md");
  if (!existsSync(file)) return { rows: [], raw: "" };
  const text = readFileSync(file, "utf8");
  const rows = text.split("\n")
    .map((l) => l.replace(/^>\s?/, "").trim())
    .filter((l) => l.startsWith("|") && !/^\|\s*-+/.test(l));
  return { rows, raw: text };
}
