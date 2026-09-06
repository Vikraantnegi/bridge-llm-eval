#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-run-results-mirror.mjs
//
// Restores the guarantee a cross-repo mirror otherwise loses (KAN-83 / ADR-044).
// The scorer's types/run-results.mirror.ts is a hand-copied mirror of the
// canonical listener/types/run-results.ts. TS cannot enforce cross-repo type
// identity, so this check does — and it FAILS CI on drift.
//
// TWO assertions, both required:
//
//   (1) BODY MATCH  — the mirror body (everything after the header block) is
//       byte-identical to canonical AS OF MIRROR_SHA. Catches a rewritten or
//       edited mirror. `git show <MIRROR_SHA>:types/run-results.ts`.
//
//   (2) PIN CURRENT — MIRROR_SHA equals the commit that LAST TOUCHED canonical
//       (`git log -1 --format=%H -- types/run-results.ts`). Catches the pin
//       being behind: canonical moved and nobody re-mirrored. Assertion (1)
//       alone can NEVER catch this — it always compares against the frozen
//       historical bytes at the pinned SHA, which by definition still match.
//
// Requires read access to a listener clone. Point LISTENER_REPO at it
// (env var or the default sibling path). In CI, check out both repos.
//
// Usage:
//   LISTENER_REPO=/path/to/listener node scripts/check-run-results-mirror.mjs
// Exit 0 = in sync. Exit 1 = drift (message says which assertion failed).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIRROR_PATH = resolve(__dirname, "../types/run-results.mirror.ts");
const CANONICAL_RELPATH = "types/run-results.ts";
const LISTENER_REPO = process.env.LISTENER_REPO
  ? resolve(process.env.LISTENER_REPO)
  : resolve(__dirname, "../../listener");

function fail(msg) {
  console.error(`\u2717 mirror check FAILED: ${msg}`);
  process.exit(1);
}

let mirrorRaw;
try {
  mirrorRaw = readFileSync(MIRROR_PATH, "utf8");
} catch (e) {
  fail(`cannot read mirror at ${MIRROR_PATH}: ${e.message}`);
}

const shaMatch = mirrorRaw.match(/MIRROR_SHA:\s*([0-9a-f]{40})\b/);
if (!shaMatch) fail("mirror has no valid 40-char MIRROR_SHA in its header");
const MIRROR_SHA = shaMatch[1];

const HEADER_END = "// ---------------------------------------------------------------------------";
const lastHeaderIdx = mirrorRaw.indexOf(HEADER_END, mirrorRaw.indexOf(HEADER_END) + 1);
if (lastHeaderIdx === -1) fail("mirror header sentinel not found (expected two rule lines)");
const mirrorBody = mirrorRaw.slice(lastHeaderIdx + HEADER_END.length).replace(/^\s*\n/, "");

function git(args) {
  return execFileSync("git", ["-C", LISTENER_REPO, ...args], { encoding: "utf8" });
}

let latestSha;
try {
  latestSha = git(["log", "-1", "--format=%H", "--", CANONICAL_RELPATH]).trim();
} catch (e) {
  fail(`cannot read canonical git log in ${LISTENER_REPO}: ${e.message}`);
}
if (!latestSha) fail(`canonical ${CANONICAL_RELPATH} not found in ${LISTENER_REPO}`);
if (latestSha !== MIRROR_SHA) {
  fail(
    `PIN STALE — MIRROR_SHA is ${MIRROR_SHA.slice(0, 7)} but canonical last changed at ` +
      `${latestSha.slice(0, 7)}. Canonical moved; re-mirror the new body and bump MIRROR_SHA.`,
  );
}

let canonicalBody;
try {
  canonicalBody = git(["show", `${MIRROR_SHA}:${CANONICAL_RELPATH}`]);
} catch (e) {
  fail(`cannot git-show canonical at ${MIRROR_SHA.slice(0, 7)}: ${e.message}`);
}

const norm = (s) => s.replace(/\s*$/, "\n");
if (norm(mirrorBody) !== norm(canonicalBody)) {
  fail(
    "BODY DIFF — mirror body is not byte-identical to canonical @ " +
      `${MIRROR_SHA.slice(0, 7)}. The mirror was edited or copied imperfectly. ` +
      "Re-copy the canonical body verbatim.",
  );
}

console.log(
  `\u2713 mirror in sync: body matches canonical @ ${MIRROR_SHA.slice(0, 7)} ` +
    "and pin is canonical's latest touch.",
);
process.exit(0);
