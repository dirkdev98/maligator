/**
 * Three-way test262 gate. Runs the suite in each GC-relevant execution mode and
 * fails on any new FAILED (a PASSED→FAILED regression against the committed
 * verdicts in scripts/test262.json). This is the pre-merge correctness gate for
 * collector changes: a bug that only manifests under the interpreter's root walk
 * or under forced per-safepoint collection shows up here.
 *
 * The modes (each a `node scripts/test262.ts --check` run — never rewrites the
 * committed baseline, exits non-zero on a regression):
 *   - compiled   native codegen, default collector          (the committed baseline)
 *   - interp     MAL_INTERP=1  (bytecode interpreter, Tier B root walk)
 *   - stress     MAL_GC_STRESS=1 (collect at every safepoint, compiled)
 *
 * Each mode is threaded purely through env vars the test262 machinery already
 * reads (MAL_INTERP folds into the artifact-cache key; MAL_GC_STRESS reaches the
 * forked test binary via runEnv) — the same env-driven dimension pattern the
 * generational build uses (MAL_GC_GENERATIONAL → build-gen). Add a mode here by
 * adding an entry to MODES; a future concurrent build is `MAL_GC_CONCURRENT=1`.
 *
 * COST: a full unscoped gate is ~3× a full test262 run, and the stress mode is
 * several× slower again (it collects constantly). DO NOT run it unscoped without
 * intent. For routine validation pass a partial selection — those never rewrite
 * the committed baseline:
 *
 *   node scripts/gate.ts --manifest tests/test262-regressions.txt   # fast, default CI gate
 *   node scripts/gate.ts --filter built-ins/WeakMap                 # a subsuite
 *   node scripts/gate.ts --modes compiled,stress --filter Map       # pick modes
 *   node scripts/gate.ts                                            # FULL — expensive
 */

import { spawnSync } from "node:child_process";

interface Mode {
	name: string;
	env: NodeJS.ProcessEnv;
}

const ALL_MODES: Array<Mode> = [
	{ name: "compiled", env: {} },
	{ name: "interp", env: { MAL_INTERP: "1" } },
	{ name: "stress", env: { MAL_GC_STRESS: "1" } },
];

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const filter = argValue("--filter");
const manifest = argValue("--manifest");
const jobs = argValue("--jobs");
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
if (jobs) {
	passthrough.push("--jobs", jobs);
}

const scope = manifest
	? `manifest ${manifest}`
	: filter
		? `filter '${filter}'`
		: "FULL SUITE (expensive)";
console.log(`[gate] three-way test262 gate — scope: ${scope}`);
console.log(`[gate] modes: ${modes.map((m) => m.name).join(", ")}\n`);

const failed: Array<string> = [];
for (const mode of modes) {
	const label = `${mode.name}${
		Object.keys(mode.env).length ? ` (${Object.entries(mode.env).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""
	}`;
	console.log(`\n[gate] === mode: ${label} ===`);
	const result = spawnSync("node", ["./scripts/test262.ts", ...passthrough], {
		stdio: "inherit",
		env: { ...process.env, ...mode.env },
	});
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
	console.log(`[gate]   ${mode.name}: ${failed.includes(mode.name) ? "FAIL" : "PASS"}`);
}
if (failed.length > 0) {
	console.log(`[gate] RESULT: FAIL — regressions in: ${failed.join(", ")}`);
	process.exit(1);
}
console.log(`[gate] RESULT: PASS — zero new FAILED across all ${modes.length} modes.`);
process.exit(0);
