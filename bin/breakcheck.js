#!/usr/bin/env node
// breakcheck CLI: `breakcheck check --path <dir> [--format text|json]
// [--fail-on error|warn]`

import fs from "node:fs";
import {
  VERSION,
  scanProject,
  summarize,
  formatText,
  formatJson,
} from "../src/breakcheck.js";

const USAGE = `breakcheck ${VERSION} — scan a project for things that will break or leak

Usage:
  breakcheck check --path <dir> [--format text|json] [--fail-on error|warn]
  breakcheck --help
  breakcheck --version

Options:
  --path DIR          Project directory to scan (required for check)
  --format FORMAT     text (default) or json
  --fail-on LEVEL     error (default) or warn — fail when findings reach this level
  --help              Show this help
  --version           Show version

Exit codes: 0 clean (or only below-threshold findings) · 1 findings at/above
--fail-on · 2 bad arguments / unreadable directory.
`;

function fail(message) {
  console.error(`breakcheck: ${message}\n\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-V")) {
  console.log(`breakcheck ${VERSION}`);
  process.exit(0);
}

if (args[0] !== "check") {
  fail(`unknown command '${args[0] || ""}' — expected 'check'.`);
}

let dir = null;
let format = "text";
let failOn = "error";
for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--path") {
    dir = args[++i];
    if (!dir) fail("--path needs a directory.");
  } else if (arg === "--format") {
    format = args[++i];
    if (format !== "text" && format !== "json") {
      fail(`--format must be 'text' or 'json', got '${format}'.`);
    }
  } else if (arg === "--fail-on") {
    failOn = args[++i];
    if (failOn !== "error" && failOn !== "warn") {
      fail(`--fail-on must be 'error' or 'warn', got '${failOn}'.`);
    }
  } else {
    fail(`unknown argument '${arg}'.`);
  }
}
if (!dir) fail("--path <dir> is required.");

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`breakcheck: '${dir}' is not a readable directory.`);
  process.exit(2);
}

const { findings, scanned } = scanProject(dir);
const { errors, warnings } = summarize(findings);
if (format === "json") {
  console.log(formatJson(findings, scanned));
} else {
  console.log(formatText(findings, scanned));
}
if (errors > 0) process.exit(1);
if (failOn === "warn" && warnings > 0) process.exit(1);
process.exit(0);
