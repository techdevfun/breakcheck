// breakcheck — scan a project for things that will break or leak:
// deprecated dependencies, end-of-life runtimes, unpinned CI actions,
// over-broad workflow permissions, unpinned Docker bases, and APIs
// that platforms have removed. Zero dependencies, plain Node.js.
//
// No network, no telemetry. Everything below is a local static check
// against a small built-in knowledge base of known removals.

import fs from "node:fs";
import path from "node:path";

export const VERSION = "0.1.0";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "coverage",
]);

const CODE_EXTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
]);

// Package -> { severity, message, fix }. Kept small on purpose: every entry
// here is a package whose deprecation / end-of-life is public and settled.
// "moment" is maintenance-mode, not deprecated, so it stays a warning.
const DEPRECATED_DEPS = {
  request: {
    severity: "error",
    message: "'request' is deprecated since 2020 and unmaintained",
    fix: "Replace with node:http / undici, axios, or node-fetch",
  },
  "request-promise": {
    severity: "error",
    message: "'request-promise' is deprecated (built on deprecated 'request')",
    fix: "Replace with axios, node-fetch, or undici",
  },
  "request-promise-native": {
    severity: "error",
    message:
      "'request-promise-native' is deprecated (built on deprecated 'request')",
    fix: "Replace with axios, node-fetch, or undici",
  },
  "node-sass": {
    severity: "error",
    message: "'node-sass' is deprecated (LibSass is end-of-life)",
    fix: "Replace with 'sass' (Dart Sass)",
  },
  tslint: {
    severity: "error",
    message: "'tslint' is deprecated",
    fix: "Replace with eslint + @typescript-eslint",
  },
  "babel-eslint": {
    severity: "error",
    message: "'babel-eslint' is deprecated",
    fix: "Replace with '@babel/eslint-parser'",
  },
  moment: {
    severity: "warn",
    message: "'moment' is in maintenance mode (no new features)",
    fix: "For new code consider day.js, date-fns, or Temporal",
  },
};

// Python packages whose deprecation is public and settled.
const DEPRECATED_PY_DEPS = {
  pycrypto: {
    severity: "error",
    message: "'pycrypto' is dead and unmaintained (last release 2013)",
    fix: "Replace with 'pycryptodome'",
  },
  nose: {
    severity: "error",
    message: "'nose' is unmaintained",
    fix: "Replace with pytest",
  },
  mock: {
    severity: "warn",
    message: "'mock' is in the standard library since Python 3.3",
    fix: "Use 'unittest.mock' instead of the backport package",
  },
};

const SECRET_PATTERNS = [
  { re: /ghp_[A-Za-z0-9]{20,}/, label: "GitHub personal access token" },
  { re: /gho_[A-Za-z0-9]{20,}/, label: "GitHub OAuth token" },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, label: "GitHub fine-grained token" },
  { re: /AKIA[0-9A-Z]{16}/, label: "AWS access key id" },
  { re: /sk-live-[A-Za-z0-9]{8,}/, label: "Stripe live secret key" },
  { re: /xox[baprs]-[A-Za-z0-9-]{8,}/, label: "Slack token" },
];

function finding(severity, rule, file, line, message, fix) {
  return { severity, rule, file, line, message, fix };
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(path.join(dir, entry.name), out);
      }
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function rel(root, file) {
  return path.relative(root, file) || path.basename(file);
}

function checkPackageJson(root, file, findings) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    findings.push(
      finding(
        "error",
        "invalid-json",
        rel(root, file),
        1,
        "package.json is not valid JSON",
        "Fix the JSON syntax",
      ),
    );
    return;
  }
  const deps = { ...(data.dependencies || {}), ...(data.devDependencies || {}) };
  for (const [name, spec] of Object.entries(deps)) {
    const dep = DEPRECATED_DEPS[name];
    if (dep) {
      findings.push(
        finding(dep.severity, "deprecated-dep", rel(root, file), 1, dep.message, dep.fix),
      );
    }
    if (name === "core-js" && typeof spec === "string" && /(^|[^0-9])2\./.test(spec)) {
      findings.push(
        finding(
          "error",
          "deprecated-dep",
          rel(root, file),
          1,
          "'core-js' 2.x is stale; core-js 3 has been current since 2019",
          "Upgrade to 'core-js' ^3",
        ),
      );
    }
    if (
      typeof spec === "string" &&
      (spec === "*" || spec === "latest" || spec.startsWith(">=") || spec === "x")
    ) {
      findings.push(
        finding(
          "warn",
          "floating-version",
          rel(root, file),
          1,
          `Dependency '${name}' uses floating version '${spec}' — installs are not reproducible`,
          "Pin to an exact version or a caret range, e.g. '^1.2.3'",
        ),
      );
    }
  }
  const engines = data.engines && data.engines.node;
  if (typeof engines === "string") {
    const m = engines.match(/(\d+)/);
    if (m && Number(m[1]) < 18) {
      findings.push(
        finding(
          "error",
          "eol-runtime",
          rel(root, file),
          1,
          `engines.node '${engines}' targets Node ${m[1]}, which is end-of-life (Node 16 EOL Sep 2023, Node 14 EOL Apr 2023)`,
          "Move engines.node to '>=18' (20 LTS recommended) and test on it",
        ),
      );
    }
  } else {
    findings.push(
      finding(
        "warn",
        "missing-engines",
        rel(root, file),
        1,
        "package.json has no engines.node field",
        "Add e.g. \"engines\": { \"node\": \">=20\" } so installers get a clear error on old Node",
      ),
    );
  }
}

function checkRequirementsTxt(root, file, findings) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) return;
    const m = line.match(/^([A-Za-z0-9_.\-]+)\s*(.*)$/);
    if (!m) return;
    const name = m[1].toLowerCase();
    const spec = m[2] || "";
    const dep = DEPRECATED_PY_DEPS[name];
    if (dep) {
      findings.push(
        finding(
          dep.severity,
          "deprecated-dep",
          rel(root, file),
          i + 1,
          dep.message,
          dep.fix,
        ),
      );
    }
    if (!spec.includes("==")) {
      findings.push(
        finding(
          "warn",
          "unpinned-requirement",
          rel(root, file),
          i + 1,
          `Requirement '${name}' is not pinned with '=='`,
          "Pin to an exact version, e.g. 'flask==3.0.0'",
        ),
      );
    }
  });
}

function checkPyproject(root, file, findings) {
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/requires-python\s*=\s*["']([^"']+)["']/);
  if (!m) {
    findings.push(
      finding(
        "warn",
        "missing-requires-python",
        rel(root, file),
        1,
        "pyproject.toml has no requires-python field",
        "Add e.g. requires-python = \">=3.11\"",
      ),
    );
    return;
  }
  const v = m[1].match(/(\d+)\.(\d+)/);
  if (v && (Number(v[1]) < 3 || (Number(v[1]) === 3 && Number(v[2]) < 9))) {
    findings.push(
      finding(
        "error",
        "eol-runtime",
        rel(root, file),
        1,
        `requires-python '${m[1]}' allows Python ${v[1]}.${v[2]}, which is end-of-life (3.8 EOL Oct 2024)`,
        "Raise requires-python to '>=3.9' (3.11+ recommended)",
      ),
    );
  }
}

function checkWorkflow(root, file, findings) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const uses = raw.match(/uses:\s*(\S+)/);
    if (uses) {
      const ref = uses[1].trim().replace(/['"]/g, "");
      if (!ref.startsWith("./") && !ref.startsWith("docker://")) {
        const at = ref.lastIndexOf("@");
        if (at === -1) {
          findings.push(
            finding(
              "error",
              "unpinned-action",
              rel(root, file),
              lineNo,
              `Action '${ref}' has no ref at all`,
              "Pin the action to a full commit SHA, e.g. 'owner/repo@<40-hex-sha>'",
            ),
          );
        } else {
          const pinned = ref.slice(at + 1);
          if (!/^[0-9a-f]{40}$/.test(pinned)) {
            findings.push(
              finding(
                "error",
                "unpinned-action",
                rel(root, file),
                lineNo,
                `Action '${ref}' is pinned to mutable ref '${pinned}' — tags and branches can be moved`,
                "Pin the action to a full commit SHA, e.g. 'owner/repo@<40-hex-sha>'",
              ),
            );
          }
        }
      }
    }
    if (/permissions:\s*write-all/.test(raw)) {
      findings.push(
        finding(
          "error",
          "broad-permissions",
          rel(root, file),
          lineNo,
          "'permissions: write-all' grants every permission to the workflow",
          "Grant only the permissions each job needs, e.g. 'permissions: { contents: read }'",
        ),
      );
    }
    if (/^\s*contents:\s*write/.test(raw)) {
      findings.push(
        finding(
          "warn",
          "broad-permissions",
          rel(root, file),
          lineNo,
          "'contents: write' at this level applies to the whole workflow/job",
          "Scope write permission to the single job that needs it, or drop it if the job only reads",
        ),
      );
    }
    if (/pull_request_target/.test(raw)) {
      findings.push(
        finding(
          "warn",
          "dangerous-trigger",
          rel(root, file),
          lineNo,
          "'pull_request_target' runs in the base-repo context with secrets available",
          "Never check out or execute untrusted PR code under pull_request_target",
        ),
      );
    }
    for (const { re, label } of SECRET_PATTERNS) {
      if (re.test(raw)) {
        findings.push(
          finding(
            "error",
            "hardcoded-secret",
            rel(root, file),
            lineNo,
            `Possible hardcoded ${label} in workflow file`,
            "Move the secret to GitHub Secrets and reference it as ${{ secrets.NAME }}",
          ),
        );
        break;
      }
    }
  });
}

function checkDockerfile(root, file, findings) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const m = raw.match(/^\s*FROM\s+(.+)$/i);
    if (!m) return;
    // FROM can carry build flags before the image, e.g.
    // "FROM --platform=linux/amd64 node:22-alpine". Skip any token that
    // looks like a flag; the first remaining token is the image.
    const tokens = m[1].trim().split(/\s+/).filter((t) => !t.startsWith("--"));
    const image = tokens[0];
    if (!image) return;
    const colon = image.lastIndexOf(":");
    const tag = colon === -1 ? null : image.slice(colon + 1);
    if (tag === null) {
      findings.push(
        finding(
          "error",
          "unpinned-base",
          rel(root, file),
          i + 1,
          `Docker base image '${image}' has no tag (defaults to latest)`,
          "Pin the base image, e.g. 'node:22-alpine'",
        ),
      );
    } else if (tag === "latest") {
      findings.push(
        finding(
          "error",
          "unpinned-base",
          rel(root, file),
          i + 1,
          `Docker base image '${image}' uses the mutable ':latest' tag`,
          "Pin the base image, e.g. 'node:22-alpine'",
        ),
      );
    } else if (/^\d+$/.test(tag)) {
      findings.push(
        finding(
          "warn",
          "mutable-tag",
          rel(root, file),
          i + 1,
          `Docker base image '${image}' pins only a major version — the tag can move`,
          "Pin a full version, e.g. 'node:22.11.0-alpine'",
        ),
      );
    }
  });
}

function checkCodeFile(root, file, findings) {
  const ext = path.extname(file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (ext !== ".py") {
      if (/XSLTProcessor/.test(raw) || /transformToFragment/.test(raw)) {
        findings.push(
          finding(
            "error",
            "removed-api",
            rel(root, file),
            lineNo,
            "XSLT in the browser is being removed from Chrome and Edge — XSLTProcessor will stop working",
            "Move the transform to the server, or pre-render the output at build time",
          ),
        );
      }
    } else {
      if (/(^|\W)imp\./.test(raw)) {
        findings.push(
          finding(
            "error",
            "removed-api",
            rel(root, file),
            lineNo,
            "The 'imp' module was removed in Python 3.12",
            "Use 'importlib' instead",
          ),
        );
      }
      if (/collections\.(Mapping|Sequence|Iterable|MutableMapping)\b/.test(raw)) {
        findings.push(
          finding(
            "error",
            "removed-api",
            rel(root, file),
            lineNo,
            "collections ABC aliases were removed in Python 3.10",
            "Use 'collections.abc.Mapping' (etc.) instead",
          ),
        );
      }
      if (/\bdistutils\b/.test(raw)) {
        findings.push(
          finding(
            "error",
            "removed-api",
            rel(root, file),
            lineNo,
            "'distutils' was removed in Python 3.12",
            "Use 'setuptools' instead",
          ),
        );
      }
    }
  });
}

export function scanProject(rootDir) {
  const root = path.resolve(rootDir);
  const findings = [];
  const files = walk(root, []);
  let scanned = 0;
  for (const file of files) {
    const name = path.basename(file);
    const relative = rel(root, file);
    if (name === "package.json" && !relative.includes("node_modules")) {
      checkPackageJson(root, file, findings);
      scanned++;
    } else if (name === "requirements.txt") {
      checkRequirementsTxt(root, file, findings);
      scanned++;
    } else if (name === "pyproject.toml") {
      checkPyproject(root, file, findings);
      scanned++;
    } else if (
      (name.endsWith(".yml") || name.endsWith(".yaml")) &&
      relative.startsWith(`.github${path.sep}workflows${path.sep}`)
    ) {
      checkWorkflow(root, file, findings);
      scanned++;
    } else if (name === "Dockerfile" || name.endsWith(".Dockerfile")) {
      checkDockerfile(root, file, findings);
      scanned++;
    } else if (CODE_EXTS.has(path.extname(file))) {
      // Only scan code files that live inside the scanned project, not in
      // vendored folders (walk already skips those).
      checkCodeFile(root, file, findings);
      scanned++;
    }
  }
  return { findings, scanned };
}

export function summarize(findings) {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else warnings++;
  }
  return { errors, warnings };
}

export function formatText(findings, scanned) {
  const lines = [];
  for (const f of findings) {
    const tag = f.severity === "error" ? "ERROR" : "WARN ";
    lines.push(
      `[${tag}] ${f.rule}: ${f.message} (${f.file}:${f.line})\n       fix: ${f.fix}`,
    );
  }
  const { errors, warnings } = summarize(findings);
  lines.push(
    `Summary: ${errors} error(s), ${warnings} warning(s), ${scanned} file(s) scanned.`,
  );
  return lines.join("\n");
}

export function formatJson(findings, scanned) {
  const { errors, warnings } = summarize(findings);
  return JSON.stringify(
    { summary: { errors, warnings, filesScanned: scanned }, findings },
    null,
    2,
  );
}
