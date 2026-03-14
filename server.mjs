#!/usr/bin/env node
/**
 * server.mjs — ENux AI WebUI Server
 *
 * Serves the web interface on http://localhost:3000
 * Proxies requests to Ollama and handles web search injection.
 *
 * Requirements:
 *   npm install express
 *
 * Usage:
 *   node server.mjs
 *   then open http://localhost:3000
 */

import express from "express";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { parse as parseHTML } from "node-html-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = 3000;
const OLLAMA_HOST = "http://localhost:11434";
const MODEL       = "qwen2.5";
const FETCH_TIMEOUT = 10000;

// ─── ENux Sources ─────────────────────────────────────────────────────────────
const ENUX_SOURCES = [
  { label: "emirpasha.com",             url: "https://www.emirpasha.com" },
  { label: "github.com/ENux-Distro",   url: "https://raw.githubusercontent.com/ENux-Distro/ENux/main/README.md", raw: true },
  { label: "r/ENux",                   url: "https://www.reddit.com/r/ENux/.json?limit=5", reddit: true },
  { label: "distrowatch.com",          url: "https://distrowatch.com/table.php?distribution=enux" },
];

const ENUX_KEYWORDS = [
  "enux", "emirpasha", "distrowatch", "bedrock linux",
  "enux-standart", "enux-installer", "enuxbootstrap", "enux-iso",
];

// ─── System Prompt ────────────────────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are the official AI assistant for ENux Linux, a Debian-based Linux distribution created by Emir, with Bedrock Linux fully integrated and pre-hijacked on the live system.

STRICT RULES:
1. For ENux-specific questions, you will be given LIVE WEB DATA from official sources. Use ONLY that data. Do not invent anything.
2. If web data does not contain the answer, say: "I couldn't find that in the ENux sources. Check https://github.com/ENux-Distro or https://distrowatch.com"
3. For general Linux questions, answer normally from your own knowledge.
4. Stay on topic: ENux, Linux, Bedrock Linux, terminals, package management, sysadmin.
5. Be concise and technically precise. You may use markdown — the UI renders it.`;

// ─── Web Search Helpers ───────────────────────────────────────────────────────
function htmlToText(html) {
  try {
    const root = parseHTML(html);
    for (const tag of ["script","style","nav","footer","header","iframe","noscript"])
      root.querySelectorAll(tag).forEach(el => el.remove());
    return root.innerText.replace(/\n{3,}/g,"\n\n").replace(/[ \t]{2,}/g," ").trim().slice(0,4000);
  } catch { return html.slice(0,4000); }
}

function parseReddit(json) {
  try {
    return (json?.data?.children ?? [])
      .map(p => `POST: ${p.data.title}\n${(p.data.selftext||"(link post)").slice(0,300)}`)
      .join("\n\n").slice(0,3000);
  } catch { return ""; }
}

async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { "User-Agent": "Mozilla/5.0 ENuxAI/1.0", "Accept": "text/html,application/json,*/*" },
    });
    if (!res.ok) return { label: source.label, text: `(HTTP ${res.status})`, ok: false };
    if (source.reddit) return { label: source.label, text: parseReddit(await res.json()) || "(no posts)", ok: true };
    if (source.raw)    return { label: source.label, text: (await res.text()).slice(0,4000), ok: true };
    return { label: source.label, text: htmlToText(await res.text()), ok: true };
  } catch (err) {
    return { label: source.label, text: `(failed: ${err.message})`, ok: false };
  }
}

async function fetchENuxSources() {
  return Promise.all(ENUX_SOURCES.map(fetchSource));
}

function needsWebSearch(text) {
  const lower = text.toLowerCase();
  return ENUX_KEYWORDS.some(kw => lower.includes(kw));
}

function buildSystemPrompt(webResults) {
  if (!webResults) return BASE_SYSTEM_PROMPT;
  const block = webResults.map(r =>
    `=== SOURCE: ${r.label} ===\n${r.text}\n=== END ===`
  ).join("\n\n");
  return `${BASE_SYSTEM_PROMPT}\n\n--- LIVE WEB DATA (use as sole source for ENux facts) ---\n\n${block}\n\n--- END WEB DATA ---`;
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve the frontend
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

// Health check — verify Ollama + model are available
app.get("/api/health", async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return res.json({ ok: false, error: "Ollama not responding" });
    const data = await r.json();
    const hasModel = (data.models ?? []).some(m => m.name.startsWith(MODEL));
    if (!hasModel) return res.json({ ok: false, error: `Model '${MODEL}' not pulled. Run: ollama pull ${MODEL}` });
    res.json({ ok: true, model: MODEL });
  } catch (err) {
    res.json({ ok: false, error: `Ollama is not running. Start with: ollama serve` });
  }
});

// Chat endpoint — streams SSE tokens back to the browser
// Body: { messages: [{role, content}], forceSearch: bool }
app.post("/api/chat", async (req, res) => {
  const { messages = [], forceSearch = false } = req.body;
  const lastMessage = messages[messages.length - 1]?.content ?? "";

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Web search if needed
  let systemPrompt = BASE_SYSTEM_PROMPT;
  const shouldSearch = forceSearch || needsWebSearch(lastMessage);

  if (shouldSearch) {
    send("search_start", { message: "Searching ENux sources..." });
    try {
      const results = await fetchENuxSources();
      systemPrompt = buildSystemPrompt(results);
      send("search_done", { sources: results.map(r => ({ label: r.label, ok: r.ok })) });
    } catch (err) {
      send("search_error", { message: err.message });
    }
  }

  // Call Ollama with streaming
  try {
    const ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        options: { temperature: 0.3, num_predict: 1024, num_ctx: 8192 },
      }),
    });

    if (!ollamaRes.ok) {
      send("error", { message: `Ollama error ${ollamaRes.status}` });
      return res.end();
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const token = parsed?.message?.content ?? "";
          if (token) send("token", { text: token });
          if (parsed.done) send("done", {});
        } catch {}
      }
    }
    send("done", {});
  } catch (err) {
    send("error", { message: err.message });
  }

  res.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────
createServer(app).listen(PORT, () => {
  console.log(`\n  ENux AI WebUI running at http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL}  ·  Ollama: ${OLLAMA_HOST}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
