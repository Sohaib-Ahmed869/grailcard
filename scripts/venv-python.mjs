// Resolve the venv interpreter across platforms: POSIX puts it in
// .venv/bin, Windows in .venv/Scripts. Hardcoding either breaks the other,
// which is how `npm run dev:vision` silently died on macOS.
//
// Usage: node scripts/venv-python.mjs [--cwd <dir>] <python args...>
// Paths resolve against the repo root, not the caller's cwd, so --cwd is
// safe to use (pytest needs services/vision as cwd for its fixtures).
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENV = join(ROOT, "services", "vision", ".venv");

const argv = process.argv.slice(2);
let cwd = ROOT;
if (argv[0] === "--cwd") {
  cwd = resolve(ROOT, argv[1]);
  argv.splice(0, 2);
}

const candidates = [
  join(VENV, "bin", "python"),
  join(VENV, "Scripts", "python.exe"),
  join(VENV, "Scripts", "python"),
];
const python = candidates.find(existsSync);
if (!python) {
  console.error(
    `No venv interpreter found. Looked in:\n${candidates.map((c) => `  ${c}`).join("\n")}\n\n` +
      `Create one with:\n  python3 -m venv services/vision/.venv\n` +
      `  services/vision/.venv/bin/pip install -r services/vision/requirements.txt`,
  );
  process.exit(1);
}

spawn(python, argv, { stdio: "inherit", cwd }).on("exit", (code) => process.exit(code ?? 1));
