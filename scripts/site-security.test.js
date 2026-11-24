"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Pages served from the public bucket. docs/ and extensions/ are never deployed;
// the extension popup runs under Chrome's own MV3 policy.
const pages = execFileSync("git", ["ls-files", "*.html"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => !file.startsWith("docs/") && !file.startsWith("extensions/"));

assert.ok(pages.length > 0, "Expected tracked HTML pages.");

function directives(policy) {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...values]) => [name.toLowerCase(), values])
  );
}

for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  const meta = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i
  );
  assert.ok(meta, `${page} must declare a Content-Security-Policy meta tag.`);

  const csp = directives(meta[1]);
  assert.deepEqual(csp.get("default-src"), ["'none'"], `${page}: default-src must be 'none'.`);
  assert.deepEqual(csp.get("base-uri"), ["'none'"], `${page}: base-uri must be 'none'.`);
  assert.ok(csp.has("form-action"), `${page}: form-action must be set.`);

  const scriptSrc = csp.get("script-src") || [];
  assert.ok(
    !scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"),
    `${page}: script-src must not allow inline or eval.`
  );

  const inlineScript = html.match(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i);
  assert.ok(!inlineScript, `${page} has an inline <script>, which its CSP would block.`);
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${page} has an inline event handler.`);
}

console.log(`Site security checks passed for ${pages.length} pages.`);
