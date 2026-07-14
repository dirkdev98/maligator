/**
 * Three-way test262 gate. Runs the suite in each GC-relevant execution mode and
 * fails on any new FAILED (a PASSED→FAILED regression against the committed
 * verdicts in scripts/test262.json). This is the pre-merge correctness gate for
 * collector changes: a bug that only manifests under the interpreter's root walk
 * or under forced per-safepoint collection shows up here.
 *
 * The modes (each a `node scripts/test262.ts --check` run — never rewrites the
 * committed baseline):
 *   - interp     MAL_INTERP=1  (bytecode interpreter, Tier B root walk; runs first)
 *   - compiled   native codegen, default collector          (the committed baseline)
 *   - stress     MAL_GC_STRESS=1 (collect at every safepoint, compiled)
 * A full interpreted run writes a preflight report. Above the 5% regression
 * limit, compiled/stress are skipped; below it, any regression still fails the
 * gate after the remaining modes run.
 *
 * Each mode is threaded purely through env vars the test262 machinery already
 * reads (MAL_INTERP folds into the artifact-cache key; MAL_GC_STRESS reaches the
 * forked test binary via runEnv) — the same env-driven dimension pattern the GC
 * build dimension uses. Since the 2026-07-10 flip the DEFAULT build is
 * generational (unsuffixed), so an unqualified gate run already exercises the gen
 * collector; the non-gen opt-out dimension is `MAL_GC_GENERATIONAL=0 npm run gate`
 * (→ `runtime/build-nongen`). Add a mode here by adding an entry to MODES; a
 * future concurrent build is `MAL_GC_CONCURRENT=1`.
 *
 * COST: a full unscoped gate adds the stress backend to the normal interpreted +
 * compiled sequence, and stress is several times slower because it collects
 * constantly. DO NOT run it unscoped without intent. For routine validation pass
 * a partial selection — those never rewrite the committed baseline:
 *
 *   node scripts/gate.ts --manifest tests/test262-regressions.txt   # fast, default CI gate
 *   node scripts/gate.ts --filter built-ins/WeakMap                 # a subsuite
 *   node scripts/gate.ts --modes compiled,stress --filter Map       # pick modes
 *   node scripts/gate.ts                                            # FULL — expensive
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import type { Test262PreflightSummary } from "../src/test262/preflight.ts";

interface Mode {
	name: string;
	env: NodeJS.ProcessEnv;
}

const ALL_MODES: Array<Mode> = [
	{ name: "interp", env: { MAL_INTERP: "1" } },
	{ name: "compiled", env: {} },
	{ name: "stress", env: { MAL_GC_STRESS: "1" } },
];

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const filter = argValue("--filter");
const manifest = argValue("--manifest");
const modesArg = argValue("--modes");

const modes = modesArg
	? modesArg.split(",").map((wanted) => {
			const mode = ALL_MODES.find((m) => m.name === wanted.trim());
			if (!mode) {
				throw new Error(
					`unknown mode '${wanted}'; known: ${ALL_MODES.map((m) => m.name).join(", ")}`,
				);
			}
			return mode;
		})
	: ALL_MODES;

// Forward the selection flags to each child run verbatim.
const passthrough: Array<string> = ["--check"];
if (filter) {
	passthrough.push("--filter", filter);
}
if (manifest) {
	passthrough.push("--manifest", manifest);
}
const scope = manifest
	? `manifest ${manifest}`
	: filter
		? `filter '${filter}'`
		: "FULL SUITE (expensive)";
const fullScope = !manifest && !filter;
if (fullScope) {
	modes.sort((a, b) => Number(b.name === "interp") - Number(a.name === "interp"));
}
console.log(`[gate] three-way test262 gate — scope: ${scope}`);
console.log(`[gate] modes: ${modes.map((m) => m.name).join(", ")}\n`);

const failed: Array<string> = [];
const skipped: Array<string> = [];
let abortCompiled = false;
for (const mode of modes) {
	if (abortCompiled && mode.name !== "interp") {
		skipped.push(mode.name);
		console.log(
			`\n[gate] mode ${mode.name}: SKIPPED (interpreted regressions exceeded limit)`,
		);
		continue;
	}

	const interpretedPreflight = fullScope && mode.name === "interp";
	if (interpretedPreflight) {
		rmSync(TEST262_METADATA.preflightFile, { force: true });
	}
	const label = `${mode.name}${
		Object.keys(mode.env).length
			? ` (${Object.entries(mode.env)
					.map(([k, v]) => `${k}=${v}`)
					.join(" ")})`
			: ""
	}`;
	console.log(`\n[gate] === mode: ${label} ===`);
	const result = spawnSync("node", ["./scripts/test262.ts", ...passthrough], {
		stdio: "inherit",
		env: {
			...process.env,
			...mode.env,
			T262_ORCHESTRATED: "1",
			T262_PREFLIGHT: interpretedPreflight ? "1" : "0",
		},
	});
	if (
		interpretedPreflight &&
		result.status === 0 &&
		existsSync(TEST262_METADATA.preflightFile)
	) {
		const preflight = JSON.parse(
			readFileSync(TEST262_METADATA.preflightFile, "utf8"),
		) as Test262PreflightSummary;
		abortCompiled = preflight.abortCompiled;
		if (preflight.regressions.length > 0) {
			failed.push(mode.name);
			console.log(
				`[gate] mode ${mode.name}: FAIL (${preflight.regressions.length}/${preflight.ranTests} regressions)`,
			);
		} else {
			console.log(`[gate] mode ${mode.name}: PASS (no new FAILED)`);
		}
		continue;
	}
	if (interpretedPreflight) {
		abortCompiled = true;
		failed.push(mode.name);
		console.log(`[gate] mode ${mode.name}: FAIL (preflight report unavailable)`);
		continue;
	}
	// test262.ts --check sets a non-zero exit code on a PASSED→FAILED regression.
	if (result.status !== 0) {
		failed.push(mode.name);
		console.log(`[gate] mode ${mode.name}: FAIL (exit ${result.status})`);
	} else {
		console.log(`[gate] mode ${mode.name}: PASS (no new FAILED)`);
	}
}

console.log("\n[gate] ================ summary ================");
for (const mode of modes) {
	const status = skipped.includes(mode.name)
		? "SKIPPED"
		: failed.includes(mode.name)
			? "FAIL"
			: "PASS";
	console.log(`[gate]   ${mode.name}: ${status}`);
}
if (failed.length > 0 || skipped.length > 0) {
	console.log(`[gate] RESULT: FAIL — regressions in: ${failed.join(", ")}`);
	process.exit(1);
}
console.log(`[gate] RESULT: PASS — zero new FAILED across all ${modes.length} modes.`);
process.exit(0);
