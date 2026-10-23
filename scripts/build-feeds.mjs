// Junta las noticias de todas las fuentes, traduce al español las que vienen en inglés
// y escribe data.json (+ translations.json, la caché de traducciones).
// Corre en GitHub Actions (Node 20), del lado del servidor: sin límites de CORS.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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
  let t = String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  t = t.replace(/<[^>]+>/g, " "); // quita etiquetas reales
  t = t.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
       .replace(/&#x([0-9a-fA-F]+);/g, (m, n) => String.fromCharCode(parseInt(n, 16)))
       .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
  t = t.replace(/<[^>]+>/g, " "); // quita etiquetas que aparecieron al decodificar (p. ej. Reddit)
  return t.replace(/\s+/g, " ").trim();
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
  ["infocampo", () => getText("https://www.infocampo.com.ar/feed/").then((x) => parseFeed(x, "infocampo", 15))],
  ["bichos", () => getText("https://bichosdecampo.com/feed/").then((x) => parseFeed(x, "bichos", 15))],
  ["ipro", () => getText("https://www.iprofesional.com/rss/impuestos").then((x) => parseFeed(x, "ipro", 15))],
  ["ambito", () => getText("https://www.ambito.com/rss/economia.xml").then((x) => parseFeed(x, "ambito", 15))],
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

// ---- Traducción EN→ES, del lado del servidor ----
// El botón "Traducir" de la página solo muestra estos textos: no depende de que el
// navegador pueda hablar con un traductor (Google corta si le piden muchas a la vez).
// Lo ya traducido se guarda en translations.json, así cada corrida traduce solo lo nuevo.
const EN_SOURCES = new Set(["hn", "dev", "reddit", "tc", "verge", "aa"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (t) => createHash("sha1").update(t).digest("hex").slice(0, 16);

let cache = {};
try { cache = JSON.parse(readFileSync("translations.json", "utf8")); } catch { cache = {}; }

async function gtx(text) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=" + encodeURIComponent(text),
        { headers: { "User-Agent": UA }, redirect: "manual" }
      );
      if (r.status === 200) {
        const d = await r.json();
        const out = (d[0] || []).map((s) => (s && s[0]) || "").join("").trim();
        if (out) return out;
      }
    } catch { /* se reintenta */ }
    if (a < 2) await sleep(1500 * (a + 1) ** 2);
  }
  return null;
}

// Primero todos los títulos y después los resúmenes, por si se corta a mitad de camino.
const queue = [];
const queued = new Set();
for (const field of ["title", "summary"]) {
  for (const it of unique) {
    const t = it[field];
    if (!EN_SOURCES.has(it.source) || !t) continue;
    const k = keyOf(t);
    if (k in cache || queued.has(k)) continue;
    queued.add(k);
    queue.push([k, t]);
  }
}

let nuevas = 0, seguidas = 0, cortado = false;
const limite = Date.now() + 8 * 60 * 1000;
async function worker() {
  while (!cortado && queue.length && Date.now() < limite) {
    const [k, t] = queue.shift();
    const es = await gtx(t);
    if (es) { cache[k] = es; nuevas++; seguidas = 0; }
    else if (++seguidas >= 6) {
      cortado = true;
      console.error("El traductor no responde: se corta por ahora y se reintenta en la próxima corrida.");
    }
    await sleep(150);
  }
}
await Promise.all([worker(), worker(), worker()]);

const usadas = new Set();
for (const it of unique) {
  if (!EN_SOURCES.has(it.source)) continue;
  const kt = keyOf(it.title);
  usadas.add(kt);
  if (cache[kt]) it.titleEs = cache[kt];
  if (it.summary) {
    const ks = keyOf(it.summary);
    usadas.add(ks);
    if (cache[ks]) it.summaryEs = cache[ks];
  }
}
// Se guardan solo las traducciones de las noticias actuales, para que el archivo no crezca.
const podada = {};
for (const k of usadas) if (cache[k]) podada[k] = cache[k];
writeFileSync("translations.json", JSON.stringify(podada));
console.log("TRADUCCIONES", nuevas, "nuevas ·", Object.keys(podada).length, "guardadas ·", queue.length, "pendientes");

writeFileSync("data.json", JSON.stringify({ updated: new Date().toISOString(), errors, items: unique }));
console.log("TOTAL", unique.length, "ítems ·", Object.keys(errors).length, "fuentes con error");
