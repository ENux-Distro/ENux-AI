#!/usr/bin/env node
/**
 * enux-chat.mjs — ENux Linux AI Assistant (Local, Ollama + Web Search)
 *
 * Requirements:
 *   - Node.js >= 18
 *   - Ollama running          →  ollama serve
 *   - Model pulled            →  ollama pull qwen2.5
 *   - npm install chalk@5 node-html-parser
 *
 * Usage:
 *   chmod +x enux-chat.mjs && ./enux-chat.mjs
 *
 * How web search works:
 *   When the user asks something ENux-related, the AI fetches live content
 *   from emirpasha.com, github.com/ENux-Distro/ENux, reddit.com/r/ENux,
 *   and distrowatch.com, strips the HTML to plain text, and injects it
 *   into the model context as grounded facts before generating a response.
 *   This prevents hallucination entirely for ENux-specific questions.
 */

import chalk from "chalk";
import * as readline from "readline";
import * as os from "os";
import { parse as parseHTML } from "node-html-parser";

// ─── Config ───────────────────────────────────────────────────────────────────
const OLLAMA_HOST    = "http://localhost:11434";
const MODEL          = "qwen2.5";          
const RAM_WARNING_GB = 8;
const FETCH_TIMEOUT  = 10000; // ms per source fetch

// ─── ENux sources to search ───────────────────────────────────────────────────
// Each entry has a label (shown in the UI) and a URL to fetch.
// GitHub README is fetched via the raw API for clean markdown text.
const ENUX_SOURCES = [
  {
    label: "emirpasha.com",
    url: "https://www.emirpasha.com",
  },
  {
    label: "github.com/ENux-Distro/ENux",
    url: "https://raw.githubusercontent.com/ENux-Distro/ENux/main/README.md",
    raw: true, // skip HTML parsing, it's already plain text
  },
  {
    label: "r/ENux",
    url: "https://www.reddit.com/r/ENux/.json?limit=5",
    reddit: true, // parse Reddit JSON API
  },
  {
    label: "Distrowatch.com",
    url: "https://distrowatch.com/table.php?distribution=enux",
  },
  {
    label: "GitHub Releases",
    url: "https://github.com/ENux-Distro/ENux/releases/",
  },
];

// Keywords that trigger an ENux web lookup before answering.
// If the user's message contains any of these, we fetch sources first.
const ENUX_TRIGGER_KEYWORDS = [
  "enux", "emirpasha", "distrowatch", "bedrock linux",
  "enux-standart", "enux-installer", "enuxbootstrap",
  "enux-iso", "enux ai", "what is enux", "tell me about enux",
];

// ─── System prompt ────────────────────────────────────────────────────────────
// This is the base prompt. When a web search is triggered, fetched content
// is appended to this before sending to the model.
const BASE_SYSTEM_PROMPT = `You are the official AI assistant for ENux Linux, built directly into the distro.

STRICT RULES:
1. For ENux-specific questions, you will be given LIVE WEB DATA fetched from official ENux sources. Use ONLY that data to answer. Do not add anything beyond what the sources say.
2. If the web data does not contain the answer, say: "I couldn't find that in the ENux sources. Check https://github.com/ENux-Distro or https://distrowatch.com."
3. For general Linux questions (not ENux-specific), answer normally and accurately from your own knowledge.
4. Stay on topic: ENux, Linux, Bedrock Linux, terminals, package management, sysadmin. Redirect anything else politely.
5. Terminal UI — plain text only. No markdown symbols (no **, no ##). Use $ for shell commands.
6. Be concise and technically precise.`;

// ─── HTML → plain text stripper ───────────────────────────────────────────────
// Extracts readable text from HTML, removes scripts/styles/nav junk.
function htmlToText(html) {
  try {
    const root = parseHTML(html);
    // Remove noise elements
    for (const tag of ["script", "style", "nav", "footer", "header", "iframe", "noscript"]) {
      root.querySelectorAll(tag).forEach(el => el.remove());
    }
    // Get text and collapse whitespace
    return root.innerText
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
      .slice(0, 4000); // cap at 4000 chars per source to stay within context
  } catch {
    return html.slice(0, 4000);
  }
}

// ─── Reddit JSON parser ───────────────────────────────────────────────────────
function parseReddit(json) {
  try {
    const posts = json?.data?.children ?? [];
    return posts.map(p => {
      const d = p.data;
      return `POST: ${d.title}\n${d.selftext ? d.selftext.slice(0, 300) : "(link post)"}`;
    }).join("\n\n").slice(0, 3000);
  } catch {
    return "";
  }
}

// ─── Fetch a single ENux source ───────────────────────────────────────────────
async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        // Use a browser-like UA so sites don't block us
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) ENuxAI/1.0",
        "Accept": "text/html,application/json,text/plain,*/*",
      },
    });

    if (!res.ok) return { label: source.label, text: `(HTTP ${res.status})` };

    if (source.reddit) {
      const json = await res.json();
      return { label: source.label, text: parseReddit(json) || "(no posts found)" };
    }

    if (source.raw) {
      const text = await res.text();
      return { label: source.label, text: text.slice(0, 4000) };
    }

    const html = await res.text();
    return { label: source.label, text: htmlToText(html) };

  } catch (err) {
    // Timeout, DNS failure, etc. — don't crash, just note it
    return { label: source.label, text: `(could not fetch: ${err.message})` };
  }
}

// ─── Web search: fetch all ENux sources in parallel ──────────────────────────
// Shows a live "searching..." status line while fetching.
async function fetchENuxSources() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let done = false;

  // Spinner in background
  const spinner = setInterval(() => {
    if (done) return;
    process.stdout.write(
      "\r  " + chalk.cyan(frames[frame++ % frames.length]) +
      chalk.dim(" searching ENux sources...")
    );
  }, 80);

  // Fetch all sources in parallel
  const results = await Promise.all(ENUX_SOURCES.map(fetchSource));

  done = true;
  clearInterval(spinner);
  process.stdout.write("\r" + " ".repeat(50) + "\r");

  // Show which sources were fetched
  console.log(chalk.dim("  ┌─ sources fetched ───────────────────────────────"));
  for (const r of results) {
    const ok = !r.text.startsWith("(could not fetch") && !r.text.startsWith("(HTTP");
    console.log(
      chalk.dim("  │ ") +
      (ok ? chalk.green("✓") : chalk.red("✗")) +
      chalk.dim(` ${r.label}`)
    );
  }
  console.log(chalk.dim("  └─────────────────────────────────────────────────"));
  console.log();

  return results;
}

// ─── Detect if a question needs ENux web search ──────────────────────────────
function needsWebSearch(text) {
  const lower = text.toLowerCase();
  return ENUX_TRIGGER_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── Build system prompt with injected web data ───────────────────────────────
function buildSystemPrompt(webResults = null) {
  if (!webResults) return BASE_SYSTEM_PROMPT;

  const sourcesBlock = webResults.map(r =>
    `=== SOURCE: ${r.label} ===\n${r.text}\n=== END: ${r.label} ===`
  ).join("\n\n");

  return `${BASE_SYSTEM_PROMPT}

=====================================================
LIVE WEB DATA — fetched right now from official ENux sources.
Use this as your ONLY source of truth for ENux facts.
Do not add anything not present in this data.
=====================================================

${sourcesBlock}

=====================================================
END OF WEB DATA
=====================================================

Answer the user's question using ONLY the above web data for ENux facts.`;
}

// ─── Terminal UI ──────────────────────────────────────────────────────────────
const WIDTH = 72;

function line(l, f, r) { return l + f.repeat(WIDTH - 2) + r; }

function boxTop(title = "") {
  if (!title) return chalk.green(line("╔", "═", "╗"));
  const pad = WIDTH - 4 - title.length;
  const l = Math.floor(pad / 2);
  const r = pad - l;
  return chalk.green("╔══" + "═".repeat(l) + " ") +
         chalk.bold.white(title) +
         chalk.green(" " + "═".repeat(r) + "╗");
}
function boxBot()   { return chalk.green(line("╚", "═", "╝")); }
function boxEmpty() { return chalk.green("║") + " ".repeat(WIDTH - 2) + chalk.green("║"); }
function boxLine(text = "", color = chalk.white) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, WIDTH - 4 - plain.length);
  return chalk.green("║ ") + color(text) + " ".repeat(pad) + chalk.green(" ║");
}

function printBox(title, lines, color = chalk.white) {
  console.log();
  console.log(boxTop(title));
  console.log(boxEmpty());
  for (const l of lines) {
    if (l.length === 0) { console.log(boxEmpty()); continue; }
    const maxLen = WIDTH - 6;
    const words = l.split(" ");
    let current = "";
    for (const word of words) {
      if ((current + " " + word).trim().length > maxLen) {
        if (current) console.log(boxLine(current.trim(), color));
        current = word;
      } else {
        current = (current + " " + word).trim();
      }
    }
    if (current) console.log(boxLine(current, color));
  }
  console.log(boxEmpty());
  console.log(boxBot());
  console.log();
}

function printBanner() {
  console.clear();
  console.log();
  console.log(chalk.bold.green("  ███████╗███╗   ██╗██╗   ██╗██╗  ██╗"));
  console.log(chalk.bold.green("  ██╔════╝████╗  ██║██║   ██║╚██╗██╔╝"));
  console.log(chalk.bold.green("  █████╗  ██╔██╗ ██║██║   ██║ ╚███╔╝ "));
  console.log(chalk.bold.green("  ██╔══╝  ██║╚██╗██║██║   ██║ ██╔██╗ "));
  console.log(chalk.bold.green("  ███████╗██║ ╚████║╚██████╔╝██╔╝ ██╗"));
  console.log(chalk.bold.green("  ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝"));
  console.log();
  console.log(
    chalk.dim("  ") + chalk.green("Linux AI Assistant") +
    chalk.dim("  ·  Ollama + qwen2.5  ·  web-aware")
  );
  console.log(
    chalk.dim("  v5.1.1-pre  ·  ") +
    chalk.cyan("ENux questions → live web lookup") +
    chalk.dim("  ·  /help for commands")
  );
  console.log();
}

function printHelp() {
  printBox("Commands", [
    "/help      — show this help",
    "/clear     — clear screen and reset history",
    "/history   — show conversation history",
    "/search    — force a web search on next message",
    "/model     — show current model info",
    "/exit      — quit enux-chat",
    "",
    "Web search triggers automatically on ENux questions.",
    "Use /search to force it for any question.",
  ], chalk.yellow);
}

// ─── RAM Check ────────────────────────────────────────────────────────────────
function checkRAM() {
  const totalGB = os.totalmem() / 1024 / 1024 / 1024;
  if (totalGB < RAM_WARNING_GB) {
    console.log(boxTop("RAM Warning"));
    console.log(boxEmpty());
    console.log(boxLine(`Your system has ~${totalGB.toFixed(1)} GB RAM.`, chalk.yellow));
    console.log(boxLine(`ENux AI requires at least ${RAM_WARNING_GB} GB to run properly.`, chalk.yellow));
    console.log(boxLine("The model may run slowly or give degraded responses.", chalk.dim));
    console.log(boxLine("You can still try — but don't say we didn't warn you.", chalk.dim));
    console.log(boxEmpty());
    console.log(boxBot());
    console.log();
  }
}

// ─── Ollama Health Check ──────────────────────────────────────────────────────
async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    const models = data.models ?? [];
    const hasModel = models.some(m => m.name.startsWith("qwen2.5"));
    if (!hasModel) {
      console.log();
      console.log(chalk.yellow(`  Model '${MODEL}' not found.`));
      console.log(chalk.dim("  Run: ") + chalk.white(`ollama pull ${MODEL}`));
      console.log(chalk.dim("  (~800 MB download, only once)\n"));
      process.exit(1);
    }
  } catch (err) {
    if (err.message === "bad response") throw err;
    console.log();
    console.log(chalk.red("  Ollama is not running."));
    console.log(chalk.dim("  Start:   ") + chalk.white("ollama serve"));
    console.log(chalk.dim("  Install: ") + chalk.white("https://ollama.com"));
    console.log(chalk.dim("  Model:   ") + chalk.white(`ollama pull ${MODEL}\n`));
    process.exit(1);
  }
}

// ─── Streaming Chat ───────────────────────────────────────────────────────────
async function streamChat(history, systemPrompt) {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
      ],
      options: {
        temperature: 0.3,  // lower temp = less creative = less hallucination
        num_predict: 1024,
        num_ctx: 8192,     // larger context window to fit web search results
      },
    }),
  });

  if (!response.ok) {
    let msg = `Ollama error ${response.status}`;
    try { const b = await response.json(); msg = b?.error ?? msg; } catch {}
    throw new Error(msg);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let dotCount = 0;

  process.stdout.write(chalk.dim("\n  ") + chalk.green("●") + chalk.dim(" thinking"));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const token = parsed?.message?.content ?? "";
        if (token) {
          fullText += token;
          if (++dotCount % 6 === 0) process.stdout.write(chalk.green("."));
        }
      } catch {}
    }
  }

  process.stdout.write("\r" + " ".repeat(50) + "\r");
  return fullText.trim();
}

// ─── Main REPL ────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  checkRAM();

  process.stdout.write(chalk.dim("  Checking Ollama... "));
  await checkOllama();
  process.stdout.write(chalk.green("ready\n\n"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on("SIGINT", () => {
    console.log(chalk.green("\n\n  Goodbye. Stay based, use ENux.\n"));
    process.exit(0);
  });

  const history = [];
  let forceSearch = false; // set true by /search command

  const prompt = () => {
    process.stdout.write(
      chalk.green("  ╔══ you ═══════════════════════════════════════════════════════════╗\n") +
      chalk.green("  ║ ") + chalk.bold.white("~$ ")
    );

    rl.once("line", async (input) => {
      const text = input.trim();
      if (!text) return prompt();

      // ── Commands ─────────────────────────────────────────────────────────────
      if (text === "/exit" || text === "/quit") {
        console.log(chalk.green("\n  Goodbye. Stay based, use ENux.\n"));
        rl.close(); process.exit(0);
      }
      if (text === "/help")  { printHelp(); return prompt(); }
      if (text === "/clear") {
        history.length = 0; forceSearch = false;
        printBanner(); checkRAM();
        console.log(chalk.dim("  History cleared.\n"));
        return prompt();
      }
      if (text === "/history") {
        if (history.length === 0) {
          console.log(chalk.dim("\n  No history yet.\n"));
        } else {
          console.log();
          history.forEach((m, i) => {
            const role = m.role === "user" ? chalk.green("you") : chalk.cyan("ENux AI");
            const preview = m.content.slice(0, 65) + (m.content.length > 65 ? "…" : "");
            console.log(chalk.dim(`  [${i + 1}] `) + role + chalk.dim(": ") + chalk.white(preview));
          });
          console.log();
        }
        return prompt();
      }
      if (text === "/model") {
        printBox("Model Info", [
          `Backend   :  Ollama  (${OLLAMA_HOST})`,
          `Model     :  ${MODEL}`,
          `Temp      :  0.3 (low — reduces hallucination)`,
          `Context   :  8192 tokens (fits web search data)`,
          `Web srcs  :  emirpasha.com, github ENux-Distro,`,
          `             r/ENux, distrowatch.com`,
        ], chalk.cyan);
        return prompt();
      }
      if (text === "/search") {
        forceSearch = true;
        console.log(chalk.cyan("\n  Web search will be used for your next message.\n"));
        return prompt();
      }

      // Close user input box
      console.log(chalk.green("  ╚" + "═".repeat(WIDTH - 4) + "╝"));

      // ── Decide whether to do a web search ────────────────────────────────────
      const shouldSearch = forceSearch || needsWebSearch(text);
      forceSearch = false;
      let systemPrompt = BASE_SYSTEM_PROMPT;

      if (shouldSearch) {
        console.log(chalk.dim(`\n  Detected ENux-related question — fetching live sources...`));
        try {
          const webResults = await fetchENuxSources();
          systemPrompt = buildSystemPrompt(webResults);
        } catch (err) {
          console.log(chalk.yellow(`  Web search failed: ${err.message} — answering from base knowledge.\n`));
        }
      }

      // ── Call model ───────────────────────────────────────────────────────────
      history.push({ role: "user", content: text });

      try {
        const reply = await streamChat(history, systemPrompt);
        history.push({ role: "assistant", content: reply });
        printBox("ENux AI" + (shouldSearch ? "  [web]" : ""), reply.split("\n"));
      } catch (err) {
        console.log();
        console.log(chalk.red("  Error: ") + chalk.white(err.message) + "\n");
        history.pop();
      }

      prompt();
    });
  };

  prompt();
}

main();
