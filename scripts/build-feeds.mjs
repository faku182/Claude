// Junta las noticias de las 9 fuentes y escribe data.json.
// Corre en GitHub Actions (Node 20), del lado del servidor: sin límites de CORS.
import { writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (compatible; MicrodosisTechBot/1.0; +https://faku182.github.io/Claude/)";

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*" } });
  if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
  return r.text();
}

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}
function clip(t, n) {
  t = t || "";
  return t.length > n ? t.slice(0, n - 1).replace(/\s\S*$/, "").trim() + "…" : t;
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return m ? m[1] : "";
}

// Parser RSS 2.0 / Atom.
function parseFeed(xml, source, limit) {
  let isAtom = false;
  let entries = xml.split(/<item[\s>]/i).slice(1).map((b) => "<item " + b);
  if (entries.length === 0) {
    isAtom = true;
    entries = xml.split(/<entry[\s>]/i).slice(1).map((b) => "<entry " + b);
  }
  const closeRe = isAtom ? /<\/entry>/i : /<\/item>/i;
  const out = [];
  for (const raw of entries.slice(0, limit)) {
    const block = raw.split(closeRe)[0];
    const title = decode(tag(block, "title"));
    let link = "";
    if (isAtom) {
      const lm = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
                 block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = lm ? lm[1] : "";
    } else {
      link = decode(tag(block, "link"));
      if (!link) { const lm = block.match(/<link[^>]*href=["']([^"']+)["']/i); if (lm) link = lm[1]; }
    }
    link = (link || "").trim();
    const ds = (tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date") || "").trim();
    const ts = ds ? (Date.parse(ds) || 0) : 0;
    const desc = tag(block, "description") || tag(block, "summary") || tag(block, "content:encoded") || tag(block, "content") || "";
    const author = decode(tag(block, "dc:creator") || tag(block, "author") || "");
    if (title && link) {
      out.push({ id: source + "|" + link, source, title, url: link, commentsUrl: link,
                 points: null, comments: null, author, ts, summary: clip(decode(desc), 240) });
    }
  }
  return out;
}

async function hn() {
  const d = await getJSON("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40");
  return (d.hits || []).filter((h) => h.title).map((h) => {
    const cu = "https://news.ycombinator.com/item?id=" + h.objectID;
    return { id: "hn" + h.objectID, source: "hn", title: h.title, url: h.url || cu, commentsUrl: cu,
             points: h.points || 0, comments: h.num_comments || 0, author: h.author || "",
             ts: (h.created_at_i || 0) * 1000, summary: "" };
  });
}
async function dev() {
  const a = await getJSON("https://dev.to/api/articles?per_page=40&top=1");
  return (a || []).map((x) => ({
    id: "dev" + x.id, source: "dev", title: x.title, url: x.url, commentsUrl: x.url + "#comments",
    points: x.positive_reactions_count || 0, comments: x.comments_count || 0,
    author: (x.user && x.user.name) || "", ts: Date.parse(x.published_at) || 0,
    summary: clip(x.description || "", 240),
  }));
}
async function reddit() {
  try {
    const d = await getJSON("https://www.reddit.com/r/technology/top.json?t=day&limit=40");
    const kids = (d.data && d.data.children) || [];
    const out = kids.map((k) => k.data).filter((p) => p && !p.stickied).map((p) => {
      const cu = "https://www.reddit.com" + p.permalink;
      return { id: "rd" + p.id, source: "reddit", title: p.title, url: p.is_self ? cu : p.url, commentsUrl: cu,
               points: p.score || 0, comments: p.num_comments || 0, author: p.author || "",
               ts: (p.created_utc || 0) * 1000, summary: clip(decode(p.selftext || ""), 240) };
    });
    if (out.length) return out;
    throw new Error("reddit json vacío");
  } catch (e) {
    const xml = await getText("https://www.reddit.com/r/technology/.rss?t=day");
    return parseFeed(xml, "reddit", 25);
  }
}

const SOURCES = [
  ["hn", hn],
  ["dev", dev],
  ["reddit", reddit],
  ["tc", () => getText("https://techcrunch.com/feed/").then((x) => parseFeed(x, "tc", 15))],
  ["verge", () => getText("https://www.theverge.com/rss/index.xml").then((x) => parseFeed(x, "verge", 15))],
  ["aa", () => getText("https://www.androidauthority.com/feed/").then((x) => parseFeed(x, "aa", 15))],
  ["xataka", () => getText("https://feeds.weblogssl.com/xataka2").then((x) => parseFeed(x, "xataka", 15))],
  ["genbeta", () => getText("https://feeds.weblogssl.com/genbeta").then((x) => parseFeed(x, "genbeta", 15))],
  ["hiper", () => getText("https://hipertextual.com/feed").then((x) => parseFeed(x, "hiper", 15))],
];

const items = [];
const errors = {};
for (const [k, fn] of SOURCES) {
  try {
    const r = await fn();
    items.push(...r);
    console.log(k.padEnd(8), r.length, "ítems");
  } catch (e) {
    errors[k] = String((e && e.message) || e);
    console.error(k.padEnd(8), "FALLÓ:", errors[k]);
  }
}

// dedup por título normalizado
const seen = new Set();
const unique = items.filter((it) => {
  const key = it.title.toLowerCase().replace(/[^a-z0-9áéíóúñ ]/gi, "").trim();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

writeFileSync("data.json", JSON.stringify({ updated: new Date().toISOString(), errors, items: unique }));
console.log("TOTAL", unique.length, "ítems ·", Object.keys(errors).length, "fuentes con error");
