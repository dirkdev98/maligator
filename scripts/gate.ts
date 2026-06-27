/**
 * Three-way test262 gate (T6.5). Runs the suite in the three modes that together
 * exercise both backends and the collector, comparing each against the committed
 * scripts/test262.json baseline WITHOUT rewriting it (`--check`):
 *
 *   1. compiled            — the default native backend (the baseline's own mode)
 *   2. --no-compiled       — the bytecode interpreter (Tier B root walk)
 *   3. compiled + STRESS   — collect every Nth safepoint (a GC crash net)
 *
 * The gate fails (non-zero exit) if ANY mode regresses a previously-PASSED test.
 *
 *   node scripts/gate.ts [--filter <substr>] [extra test262 args]
 *
 * Tuning:
 *   GATE_STRESS=<N>   MAL_GC_STRESS value for mode 3 (default 100; set 1 for the
 *                     thorough-but-slow collect-at-every-safepoint run).
 *   GATE_SKIP_STRESS=1 / GATE_SKIP_INTERP=1   skip that mode.
 *
 * CAVEAT — flakiness floor: a known async/dynamic-import subset alternates
 * PASS/FAIL run-to-run (see TODO.md / the test262-gate-flakiness memory), so a
 * 1–2 test "regression" in the interpreter/stress modes may be noise, not a real
 * break. Treat a clean compiled mode + no NEW crashes as the load-bearing signal;
 * eyeball small regressions in the other two before trusting them.
 */

import { spawnSync } from "node:child_process";

interface Mode {
	name: string;
	env: NodeJS.ProcessEnv;
	enabled: boolean;
}

const stressN = process.env.GATE_STRESS ?? "100";
const passthrough = process.argv.slice(2);

const modes: Array<Mode> = [
	{ name: "compiled", env: {}, enabled: true },
	{
		name: "interpreter (--no-compiled)",
		env: { T262_NO_COMPILED: "1" },
		enabled: process.env.GATE_SKIP_INTERP !== "1",
	},
	{
		name: `compiled + MAL_GC_STRESS=${stressN}`,
		env: { MAL_GC_STRESS: stressN },
		enabled: process.env.GATE_SKIP_STRESS !== "1",
	},
	// Generational collector (opt-in via GATE_GEN=1 — it builds a separate
	// runtime/build-gen archive and is slow, so it is not part of the default
	// gate). Runs compiled + STRESS so the generational card barrier's
	// remembered-set completeness is exercised (a missed old→young edge surfaces
	// as a regression here or a MAL_GC_VERIFY abort).
	{
		name: `generational (MAL_GC_GENERATIONAL=1) + STRESS=${stressN}`,
		env: { MAL_GC_GENERATIONAL: "1", MAL_GC_STRESS: stressN, MAL_GC_VERIFY: "1" },
		enabled: process.env.GATE_GEN === "1",
	},
];

const results: Array<{ name: string; ok: boolean }> = [];

for (const mode of modes) {
	if (!mode.enabled) {
		console.log(`\n=== gate: SKIP ${mode.name} ===`);
		continue;
	}
	console.log(`\n=== gate: ${mode.name} ===`);
	const result = spawnSync("node", ["./scripts/test262.ts", "--check", ...passthrough], {
		stdio: "inherit",
		env: { ...process.env, ...mode.env },
	});
	// test262.ts sets exit code 1 on a regression; any other non-zero is a crash
	// of the runner itself — both fail the mode.
	results.push({ name: mode.name, ok: result.status === 0 });
}

console.log("\n=== gate summary ===");
for (const { name, ok } of results) {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
}

const anyFailed = results.some((r) => !r.ok);
if (anyFailed) {
	console.log("\nGate FAILED — review the regressions above (mind the flakiness floor).");
	process.exit(1);
}
console.log("\nGate PASSED — no regressions in any mode.");
