/**
 * Differential correctness oracle for the emit-c backend.
 *
 * Builds a JS/TS fixture twice — once with the native compiled bodies (default)
 * and once forced through the bytecode interpreter (`--no-compiled`) — runs both,
 * and diffs stdout. The interpreter is the reference implementation; any
 * divergence is an emit-c miscompile. Runs each mode under GC stress too, so a
 * missed root in a compiled body surfaces.
 *
 * Usage: node scripts/diff-compiled.ts <fixture.js> [--stress]
 * Exit 0 iff compiled and interpreted outputs match.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const fixture = process.argv[2];
if (fixture === undefined) {
	console.error("usage: node scripts/diff-compiled.ts <fixture.js> [--stress]");
	process.exit(2);
}
const stress = process.argv.includes("--stress");
const repoRoot = path.resolve(import.meta.dirname, "..");

function build(name: string, extraArgs: Array<string>): string {
	const args = [
		path.join(repoRoot, "src/index.ts"),
		"build",
		path.resolve(fixture!),
		"--name",
		name,
		...extraArgs,
	];
	const output = execFileSync("node", args, { cwd: repoRoot, encoding: "utf-8" });
	// Build stdout is a scripting contract: exactly the resulting binary path.
	const binaryPath = output.trim();
	if (binaryPath === "") {
		throw new Error(`no binary path in build output:\n${output}`);
	}
	return path.resolve(repoRoot, binaryPath);
}

function run(binary: string): { out: string; code: number } {
	try {
		const out = execFileSync(binary, {
			encoding: "utf-8",
			env: stress
				? { ...process.env, MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" }
				: process.env,
			timeout: 30000,
		});
		return { out, code: 0 };
	} catch (error) {
		const e = error as { stdout?: string; status?: number };
		return { out: e.stdout ?? "", code: e.status ?? -1 };
	}
}

const compiledBin = build("diff-compiled", []);
const interpBin = build("diff-interp", ["--no-compiled"]);

const compiled = run(compiledBin);
const interp = run(interpBin);

if (compiled.out === interp.out && compiled.code === interp.code) {
	console.log(
		`MATCH (${compiled.out.split("\n").length - 1} lines, exit ${compiled.code})`,
	);
	process.exit(0);
}

console.log("DIVERGENCE");
console.log(`  compiled exit=${compiled.code}, interpreter exit=${interp.code}`);
const cl = compiled.out.split("\n");
const il = interp.out.split("\n");
const max = Math.max(cl.length, il.length);
for (let i = 0; i < max; i++) {
	if (cl[i] !== il[i]) {
		console.log(`  line ${i + 1}:`);
		console.log(`    compiled:    ${JSON.stringify(cl[i])}`);
		console.log(`    interpreter: ${JSON.stringify(il[i])}`);
	}
}
process.exit(1);
