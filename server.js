// Ketchikan Planning Fact Book: static reference site + "Ask" endpoint backed by the Claude API.
// Every question is answered against the documents in ./docs, with citations back to the source text.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { readdir, readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8000;
const CACHE_TTL = process.env.CACHE_TTL === "5m" ? "5m" : "1h";
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "docs");
const PASSCODE = process.env.APP_PASSCODE || "";
const RATE_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";

const client = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

// Opus 5.5 is the floor. A newer claude-opus-* id from the Models API replaces it.
// CLAUDE_MODEL pins one id and skips that check. Anthropic does not publish a floating "latest" alias.
const PINNED_OPUS = "claude-opus-5-5";

function opusRank(id) {
  const match = /^claude-opus-(\d+)(?:-(\d+))?$/.exec(id);
  if (!match) return null;
  return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
}

function isNewerOpus(candidate, current) {
  const next = opusRank(candidate);
  const prev = opusRank(current);
  if (!next || !prev) return false;
  return next[0] > prev[0] || (next[0] === prev[0] && next[1] > prev[1]);
}

async function resolveModel() {
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;
  if (!client) return PINNED_OPUS;
  try {
    let best = PINNED_OPUS;
    for await (const model of client.models.list({}, { timeout: 10_000 })) {
      if (!opusRank(model.id)) continue;
      if (model.capabilities?.citations?.supported === false) continue;
      if (model.max_input_tokens != null && model.max_input_tokens < 200_000) continue;
      if (isNewerOpus(model.id, best)) best = model.id;
    }
    return best;
  } catch (err) {
    console.warn(`Could not check for a newer Opus (${err.message}). Using ${PINNED_OPUS}.`);
    return PINNED_OPUS;
  }
}

const MODEL = await resolveModel();

const SYSTEM_PROMPT = `You are a research assistant for a member of the Ketchikan Gateway Borough Planning Commission (Ketchikan, Alaska). He asks questions during and before public meetings and needs fast, accurate answers drawn from the reference documents provided in this conversation.

How to answer:
- Answer from the documents and cite them. If the documents don't answer the question, say so plainly in the first sentence. You may then add general knowledge, clearly labeled as not from the documents.
- Lead with the direct answer in one or two sentences, then a few short supporting points. Keep it readable at the dais: usually under 150 words unless he asks for more detail.
- Keep three kinds of source distinct: adopted Comprehensive Plan language (policy), Borough code (legal requirement), and the Planning Fact Book or outside research (secondary summary). When the Fact Book and a primary document cover the same point, rely on the primary document.
- Give page numbers when the text shows them ("[Page N]" markers, or "Page N of 145" footers in the appendices), and give plan strategy and action numbers (for example, Housing 2c or Land Use 2a).
- If figures or action letters conflict between documents, say so.
- Use plain text and short bullet points. No headings. No preamble.
- This is not legal advice. When a question concerns a quasi-judicial item (a conditional use permit, variance, plat, or single-parcel rezone), you may briefly remind him that the decision must rest on the code's approval criteria and the hearing record. Don't repeat this on every answer.`;

/* ------------------------- Documents ------------------------- */

const PAGE_PATTERNS = [/\[Page (\d+)\]/g, /Page (\d+) of \d+/g];

function titleFromFile(file) {
  // "01-KGB 2035 Comprehensive Plan - Core Plan.txt" -> "KGB 2035 Comprehensive Plan – Core Plan"
  let t = file.replace(/\.[^.]+$/, "").replace(/^\d+[-_ ]+/, "").replace(/_/g, " ").replace(/\s+-\s+/g, " – ");
  if (t === t.toLowerCase()) t = t.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return t.replace(/\s+/g, " ").trim();
}

function buildPageIndex(text) {
  const marks = [];
  for (const re of PAGE_PATTERNS) {
    for (const m of text.matchAll(re)) marks.push({ at: m.index, page: Number(m[1]) });
  }
  return marks.sort((a, b) => a.at - b.at);
}

function pageAt(doc, index) {
  // Most recent page marker at or before the cited character.
  let page = null;
  for (const m of doc.pages) {
    if (m.at > index) break;
    page = m.page;
  }
  return page;
}

async function pdfToText(buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    if (Array.isArray(result.pages) && result.pages.length) {
      return result.pages.map((p, i) => `[Page ${p.num ?? i + 1}]\n${p.text}`).join("\n\n");
    }
    return result.text;
  } finally {
    await parser.destroy?.();
  }
}

async function loadDocuments() {
  let files = [];
  try {
    files = (await readdir(DOCS_DIR)).filter((f) => /\.(txt|md|pdf)$/i.test(f)).sort();
  } catch {
    console.warn(`No docs folder at ${DOCS_DIR}`);
  }
  const docs = [];
  for (const file of files) {
    const full = path.join(DOCS_DIR, file);
    try {
      const text = /\.pdf$/i.test(file)
        ? await pdfToText(await readFile(full))
        : await readFile(full, "utf8");
      const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!clean) continue;
      docs.push({ file, title: titleFromFile(file), text: clean, pages: buildPageIndex(clean), chars: clean.length });
    } catch (err) {
      console.error(`Could not read ${file}: ${err.message}`);
    }
  }
  const total = docs.reduce((s, d) => s + d.chars, 0);
  console.log(`Loaded ${docs.length} documents, ${total.toLocaleString()} characters (about ${Math.round(total / 4).toLocaleString()} tokens).`);
  if (total > 3_000_000) console.warn("Documents are close to the model's context limit. Remove some files from docs/.");
  return docs;
}

const DOCS = await loadDocuments();

function documentBlocks() {
  return DOCS.map((d, i) => ({
    type: "document",
    source: { type: "text", media_type: "text/plain", data: d.text },
    title: d.title,
    citations: { enabled: true },
    // One cache breakpoint after the last document caches the whole document set.
    ...(i === DOCS.length - 1 ? { cache_control: { type: "ephemeral", ttl: CACHE_TTL } } : {}),
  }));
}

/* ------------------------- Guards ------------------------- */

function passcodeOk(req) {
  if (!PASSCODE) return true;
  const given = Buffer.from(String(req.get("x-passcode") || ""));
  const want = Buffer.from(PASSCODE);
  return given.length === want.length && timingSafeEqual(given, want);
}

const hits = new Map();
function rateOk(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_PER_MIN) return false;
  recent.push(now);
  hits.set(ip, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 60_000)) hits.delete(ip);
}, 300_000).unref();

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
}

/* ------------------------- App ------------------------- */

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/status", (req, res) => {
  res.json({
    askEnabled: Boolean(client) && DOCS.length > 0,
    keyConfigured: Boolean(client),
    passcodeRequired: Boolean(PASSCODE),
    model: MODEL,
    cacheTtl: CACHE_TTL,
    documents: DOCS.map((d) => ({ title: d.title, file: d.file, chars: d.chars })),
  });
});

function guard(req, res) {
  if (!client) { res.status(503).json({ error: "The server has no ANTHROPIC_API_KEY set." }); return false; }
  if (!passcodeOk(req)) { res.status(401).json({ error: "Wrong or missing passcode." }); return false; }
  if (!rateOk(req.ip)) { res.status(429).json({ error: "Too many questions in the last minute. Wait a moment and try again." }); return false; }
  if (!DOCS.length) { res.status(503).json({ error: "No documents are loaded. Add files to the docs folder." }); return false; }
  return true;
}

function apiErrorMessage(err) {
  const status = err?.status;
  if (status === 401) return "The Claude API key was rejected. Check ANTHROPIC_API_KEY.";
  if (status === 429) return "The Claude API rate limit was hit. Wait a moment and try again.";
  if (status === 529 || status === 503) return "Claude is overloaded right now. Try again in a few seconds.";
  if (status === 400) return `The request was rejected: ${err?.error?.error?.message || err.message}`;
  return "Something went wrong reaching Claude. Try again.";
}

// Pre-loads the documents into the prompt cache so the first real question is fast.
app.post("/api/warm", async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [...documentBlocks(), { type: "text", text: "Reply with OK." }] }],
    });
    res.json({ ok: true, usage: msg.usage });
  } catch (err) {
    console.error("warm failed", err?.status, err?.message);
    res.status(502).json({ error: apiErrorMessage(err) });
  }
});

app.post("/api/ask", async (req, res) => {
  if (!guard(req, res)) return;
  const question = String(req.body?.question || "").trim().slice(0, 4000);
  if (!question) return res.status(400).json({ error: "Type a question first." });
  const history = cleanHistory(req.body?.history);

  // The documents always lead the first user turn, so the cached prefix is identical on every request.
  const turns = [...history, { role: "user", content: question }];
  if (turns[0].role !== "user") turns.shift();
  const messages = turns.map((t, i) =>
    i === 0
      ? { role: "user", content: [...documentBlocks(), { type: "text", text: t.content }] }
      : { role: t.role, content: t.content }
  );

  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let stream;
  let closed = false;
  res.on("close", () => { closed = true; stream?.abort?.(); });

  try {
    stream = client.messages.stream({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages });
    for await (const ev of stream) {
      if (closed) break;
      if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
        send({ type: "block" });
      } else if (ev.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta") send({ type: "text", text: ev.delta.text });
        else if (ev.delta?.type === "citations_delta") {
          const c = ev.delta.citation || {};
          const doc = DOCS[c.document_index];
          send({
            type: "cite",
            title: c.document_title || doc?.title || "Document",
            file: doc?.file,
            page: doc && typeof c.start_char_index === "number" ? pageAt(doc, c.start_char_index) : null,
            text: String(c.cited_text || "").slice(0, 600),
          });
        }
      }
    }
    if (!closed) {
      const final = await stream.finalMessage().catch(() => null);
      send({ type: "done", usage: final?.usage || null, stop: final?.stop_reason || null });
    }
  } catch (err) {
    if (!closed) {
      console.error("ask failed", err?.status, err?.message);
      send({ type: "error", error: apiErrorMessage(err) });
    }
  } finally {
    if (!closed) res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Fact Book running on port ${PORT}. Model ${MODEL}. Ask ${client ? "enabled" : "disabled (no ANTHROPIC_API_KEY)"}.${PASSCODE ? " Passcode required." : ""}`);
});
