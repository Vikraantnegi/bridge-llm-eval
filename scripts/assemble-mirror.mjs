import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LISTENER = "D:/apps/listener";
const SHA = execFileSync(
  "git",
  ["-C", LISTENER, "log", "-1", "--format=%H", "--", "types/run-results.ts"],
  { encoding: "utf8" },
).trim();

const body = execFileSync("git", ["-C", LISTENER, "show", `${SHA}:types/run-results.ts`], {
  encoding: "utf8",
});

const header = `// ---------------------------------------------------------------------------
// MIRROR — DO NOT EDIT BY HAND EXCEPT TO RE-SYNC.
//
// MIRROR_OF: listener/types/run-results.ts
// MIRROR_SHA: ${SHA}
//
// This is a byte-exact copy of the canonical run_results contract, which lives
// ONLY in the listener repo (a private Next app; nothing is importable as an
// @sprintzero/* package). The scorer runs on the Bridge/pipeline-worker side
// and MUST NOT import from listener (ADR-044: the judge ships no Listener
// coupling). So we mirror.
//
// A mirror does NOT give the cross-repo type-system guarantee we chose TS for:
// if the canonical file renames nonGoals, THIS file still compiles against its
// own stale copy and the rubrics would silently score a field that no longer
// exists. That guarantee is restored OUT OF BAND by scripts/check-run-results-
// mirror.mjs, which fails CI when (1) this body is not byte-identical to
// canonical @ MIRROR_SHA, OR (2) MIRROR_SHA is not the commit that last touched
// canonical (i.e. canonical moved and nobody re-mirrored). Both assertions are
// required; assertion (1) alone only proves a faithful copy of a FROZEN version.
//
// To re-sync: copy the new canonical body verbatim, update MIRROR_SHA to
// git log -1 --format=%H -- types/run-results.ts from the listener clone, and
// let the check pass.
// ---------------------------------------------------------------------------

`;

mkdirSync("types", { recursive: true });
writeFileSync("types/run-results.mirror.ts", header + body, "utf8");
console.log(`SHA=${SHA}`);
console.log(`bodyBytes=${Buffer.byteLength(body)}`);
