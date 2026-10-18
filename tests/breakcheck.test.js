import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "breakcheck.js");
const SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "breakcheck-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function run(dir, extra = []) {
  return spawnSync(process.execPath, [BIN, "check", "--path", dir, ...extra], {
    encoding: "utf8",
  });
}

const CLEAN_PKG = JSON.stringify({
  dependencies: { axios: "^1.7.0" },
  engines: { node: ">=20" },
});

test("clean project exits 0 with zero findings", () => {
  const dir = tmpProject({
    "package.json": CLEAN_PKG,
    "Dockerfile": "FROM node:22-alpine\n",
    "app.js": "console.log('hello');\n",
    ".github/workflows/ci.yml":
      `name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@${SHA}\n`,
  });
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Summary: 0 error\(s\), 0 warning\(s\)/);
});

test("broken project reports every check family and exits 1", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({
      dependencies: { request: "^2.88.0", moment: "^2.29.0", foo: "*" },
      engines: { node: "14" },
    }),
    ".github/workflows/ci.yml":
      "name: CI\non: [push]\npermissions: write-all\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo AKIAIOSFODNN7EXAMPLE\n",
    Dockerfile: "FROM node:latest\n",
    "app.js": "const t = new XSLTProcessor();\n",
    "legacy.py": "import imp\nimp.load_source('x', 'y.py')\n",
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  for (const rule of [
    "deprecated-dep", // request
    "eol-runtime", // node 14
    "unpinned-action", // checkout@v4
    "broad-permissions", // write-all
    "hardcoded-secret", // AWS example key in fixture
    "unpinned-base", // :latest
    "removed-api", // XSLT + imp
  ]) {
    assert.match(r.stdout, new RegExp(rule), `missing rule ${rule}`);
  }
  assert.match(r.stdout, /floating-version/); // foo: *
  assert.match(r.stdout, /Summary: \d+ error\(s\), \d+ warning\(s\)/);
});

test("warnings alone do not fail unless --fail-on warn", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({
      dependencies: { moment: "^2.29.0" },
      engines: { node: ">=20" },
    }),
  });
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, ["--fail-on", "warn"]).status, 1);
});

test("JSON output is parseable and carries summary + findings", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({
      dependencies: { request: "^2.88.0" },
      engines: { node: ">=20" },
    }),
  });
  const r = run(dir, ["--format", "json"]);
  assert.equal(r.status, 1);
  const data = JSON.parse(r.stdout);
  assert.equal(data.summary.errors, 1);
  assert.equal(data.findings[0].rule, "deprecated-dep");
  assert.equal(data.findings[0].file, "package.json");
  assert.ok(data.findings[0].fix);
});

test("core-js 2.x is an error, core-js 3.x is fine", () => {
  const oldDir = tmpProject({
    "package.json": JSON.stringify({
      dependencies: { "core-js": "^2.6.0" },
      engines: { node: ">=20" },
    }),
  });
  assert.match(run(oldDir).stdout, /core-js/);
  const newDir = tmpProject({
    "package.json": JSON.stringify({
      dependencies: { "core-js": "^3.36.0" },
      engines: { node: ">=20" },
    }),
  });
  assert.equal(run(newDir).status, 0);
});

test("Python: pycrypto error, unpinned warn, imp/distutils/collections removed-api", () => {
  const dir = tmpProject({
    "requirements.txt": "pycrypto==2.6.1\nflask\n",
    "pyproject.toml": '[project]\nrequires-python = ">=3.8"\n',
    "old.py": "import distutils\nfrom collections import Mapping\n",
  });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /deprecated-dep/); // pycrypto
  assert.match(r.stdout, /unpinned-requirement/); // flask
  assert.match(r.stdout, /eol-runtime/); // requires-python 3.8
  assert.match(r.stdout, /removed-api/); // distutils + Mapping
});

test("missing directory exits 2, bad flag exits 2, bad format exits 2", () => {
  assert.equal(run("/nonexistent-dir-xyz").status, 2);
  const dir = tmpProject({ "package.json": CLEAN_PKG });
  const badFlag = spawnSync(process.execPath, [BIN, "check", "--path", dir, "--nope"], { encoding: "utf8" });
  assert.equal(badFlag.status, 2);
  const badFormat = spawnSync(process.execPath, [BIN, "check", "--path", dir, "--format", "yaml"], { encoding: "utf8" });
  assert.equal(badFormat.status, 2);
});

test("--help and --version exit 0", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  const version = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /breakcheck 0\.1\.0/);
});

test("Dockerfile major-only tag is a warning, full pin is clean", () => {
  const warnDir = tmpProject({
    "package.json": CLEAN_PKG,
    Dockerfile: "FROM node:22\n",
  });
  const r = run(warnDir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /mutable-tag/);
  const cleanDir = tmpProject({
    "package.json": CLEAN_PKG,
    Dockerfile: "FROM node:22.11.0-alpine\n",
  });
  assert.equal(run(cleanDir).status, 0);
});

test("pull_request_target is a warning, not an error", () => {
  const dir = tmpProject({
    "package.json": CLEAN_PKG,
    ".github/workflows/ci.yml":
      `on:\n  pull_request_target:\n    types: [opened]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA}\n`,
  });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dangerous-trigger/);
});

test("missing engines.node is a warning; missing requires-python is a warning", () => {
  const dir = tmpProject({
    "package.json": JSON.stringify({ dependencies: {} }),
    "pyproject.toml": "[project]\nname = \"x\"\n",
  });
  const r = run(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /missing-engines/);
  assert.match(r.stdout, /missing-requires-python/);
});
