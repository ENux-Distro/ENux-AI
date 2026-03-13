# ENux AI — Makefile
# Usage:
#   make          — full install (Ollama + model + npm deps)
#   make run      — start the chatbot
#   make update   — pull latest deepseek-coder model
#   make clean    — remove node_modules
#   make uninstall — remove Ollama + node_modules

SCRIPT  = enux-chat.mjs
MODEL   = qwen2.5
NODE    = node

# ─── Default target ───────────────────────────────────────────────────────────
all: check-node install-ollama pull-model npm-install chmod
	@echo ""
	@echo "  ENux AI is ready. Run with: make run"
	@echo ""

# ─── Check Node.js >= 18 ──────────────────────────────────────────────────────
check-node:
	@echo "[1/4] Checking Node.js..."
	@$(NODE) -e "const v = process.versions.node.split('.')[0]; if (v < 18) { console.error('  Error: Node.js 18+ required (you have ' + process.versions.node + ')'); process.exit(1); }" \
		|| (echo "  Install Node.js 18+ from https://nodejs.org" && exit 1)
	@echo "  Node.js OK ($(shell node -v))"

# ─── Install Ollama ───────────────────────────────────────────────────────────
install-ollama:
	@echo ""
	@echo "[2/4] Installing Ollama..."
	@if command -v ollama > /dev/null 2>&1; then \
		echo "  Ollama already installed ($(shell ollama -v 2>/dev/null || echo unknown))"; \
	else \
		curl -fsSL https://ollama.com/install.sh | sh; \
	fi

# ─── Pull deepseek-coder model ────────────────────────────────────────────────
pull-model:
	@echo ""
	@echo "[3/4] Pulling $(MODEL) model (~800 MB, only once)..."
	@ollama pull $(MODEL)

# ─── Install npm dependencies ─────────────────────────────────────────────────
npm-install:
	@echo ""
	@echo "[4/4] Installing npm dependencies..."
	@if [ ! -f package.json ]; then npm init -y > /dev/null; fi
	@npm install chalk@5 node-html-parser

# ─── Make script executable ───────────────────────────────────────────────────
chmod:
	@chmod +x $(SCRIPT)

# ─── Run the chatbot ──────────────────────────────────────────────────────────
run: chmod
	@$(NODE) $(SCRIPT)

# ─── Update model ─────────────────────────────────────────────────────────────
update:
	@echo "Updating $(MODEL)..."
	@ollama pull $(MODEL)
	@echo "Done."

# ─── Clean node_modules ───────────────────────────────────────────────────────
clean:
	@echo "Removing node_modules..."
	@rm -rf node_modules package-lock.json
	@echo "Done."

# ─── Uninstall everything ─────────────────────────────────────────────────────
uninstall: clean
	@echo "Removing Ollama..."
	@if command -v ollama > /dev/null 2>&1; then \
		sudo rm -f /usr/local/bin/ollama; \
		sudo rm -rf /usr/share/ollama; \
		echo "  Ollama removed."; \
	else \
		echo "  Ollama not found, skipping."; \
	fi

.PHONY: all check-node install-ollama pull-model npm-install chmod run update clean uninstall
