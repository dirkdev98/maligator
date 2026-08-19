import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Build-time TypeScript support via the homegrown blank-in-place stripper (eval
 * Phase 1). Each fixture is a `.ts` file compiled through the normal pipeline
 * (`node src/index.ts`) and run; we assert the program output AND — because
 * erasure replaces type spans with whitespace in place, preserving every byte
 * offset and newline — that a thrown error's stack trace reports the ORIGINAL
 * `.ts` line/column.
 */

interface RunResult {
	stdout: string;
	code: number;
	error?: string;
}

function buildAndRun(tsPath: string, name: string): RunResult {
	let buildOutput: string;
	try {
		buildOutput = execFileSync(
			"node",
			["src/index.ts", "build", tsPath, "--name", name],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch (error) {
		const e = error as { status?: number };
		return {
			stdout: "",
			code: -1,
			error: `build failed${e.status === undefined ? "" : ` (exit ${e.status})`}`,
		};
	}
	// Build stdout is a scripting contract: exactly the resulting binary path.
	const binaryPath = buildOutput.trim();
	if (binaryPath === "") {
		return {
			stdout: "",
			code: -1,
			error: `build produced no binary path:\n${buildOutput}`,
		};
	}
	const binary = path.resolve(binaryPath);
	try {
		const stdout = execFileSync(binary, [], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { stdout, code: 0 };
	} catch (error) {
		const e = error as { code?: string; stdout?: string; status?: number };
		return {
			stdout: e.stdout ?? "",
			code: e.status ?? 1,
			error: e.code === "ENOENT" ? `binary not found: ${binary}` : undefined,
		};
	}
}

const dir = mkdtempSync(path.join(tmpdir(), "mal-tsstrip-"));
let failures = 0;

// 1. Type syntax (interface / type alias / generics / as / annotations) strips,
//    and the program runs with the expected output.
{
	const ts = `interface P { x: number }
type Id<T> = T;
const f = (p: P): number => p.x * 2;
const xs: Array<number> = [1, 2, 3];
console.log(f({ x: 21 } as Id<P>), xs.map((n: number): number => n + 1).join(","));`;
	const file = path.join(dir, "strip.ts");
	writeFileSync(file, ts);
	const r = buildAndRun(file, "tsstrip_strip");
	const ok = r.code === 0 && r.stdout === "42 2,3,4\n";
	console.log(
		ok
			? "  ok   strips + runs"
			: `  FAIL strips + runs: exit ${r.code} ${JSON.stringify(r.stdout)}${r.error === undefined ? "" : ` (${r.error})`}`,
	);
	if (!ok) {
		failures++;
	}
}

// 2. Blank-in-place erasure preserves positions: the stack reports the original .ts lines
//    (the throw is line 2, the call site is line 5).
{
	const ts = `function boom(n: number): never {
	throw new Error("trace");
}
try {
	boom(1 as number);
} catch (e: unknown) {
	console.log((e as Error).stack);
}`;
	const file = path.join(dir, "trace.ts");
	writeFileSync(file, ts);
	const r = buildAndRun(file, "tsstrip_trace");
	const throwLine = /trace\.ts:2:/.test(r.stdout);
	const callLine = /trace\.ts:5:/.test(r.stdout);
	const ok = r.code === 0 && throwLine && callLine;
	console.log(
		ok
			? "  ok   stack lines match source"
			: `  FAIL stack lines: ${JSON.stringify(r.stdout)}${r.error === undefined ? "" : ` (${r.error})`}`,
	);
	if (!ok) {
		failures++;
	}
}

console.log(
	failures === 0 ? "\nall type-strip fixtures pass" : `\n${failures} fixture(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
