import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { compileEntrypointToBuffer } from "../src/compile-program.ts";
import { buildLoadDriver } from "../src/local-build.ts";
import { stripTypesWithTypeScript } from "../src/typescript-strip.ts";

/**
 * Differential validation for the definition wire format + C loader (eval Phase
 * 2, slice 2). Each fixture is compiled two ways and must produce byte-identical
 * stdout + exit code:
 *   - C-baked:  node src/index.ts build <fixture> --name X  →  run its printed binary
 *   - loaded:   node src/index.ts build <fixture> --serialize X.malw  →  MaligatorLoad X.malw
 * Both run the same lowered definition — once compiled into C, once decoded from
 * the buffer — so identical behavior proves the serializer + loader are faithful.
 */

const FIXTURES: Record<string, string> = {
	arithmetic: `
		let acc = 0;
		for (let i = 0; i < 5; i++) acc += i * 2 + 0.5;
		console.log(acc, 2 ** 10, (7 >>> 1) | 1, -0 === 0);
	`,
	strings: `
		const a = "foo", b = "bar";
		const n = 3;
		console.log(a + b, \`\${a}-\${b}-\${n * n}\`, "héllo".length, "ab".repeat(3));
	`,
	closures: `
		function counter() { let n = 0; return () => ++n; }
		const c = counter();
		console.log(c(), c(), c());
	`,
	objects: `
		const o = { x: 1, y: 2, label: "p" };
		const { x, ...rest } = o;
		console.log(o.x + o.y, o.label, JSON.stringify(rest), Object.keys(o).join(","));
	`,
	arrays: `
		const xs = [1, 2, 3, 4];
		const doubled = xs.map((v) => v * 2).filter((v) => v > 2);
		let sum = 0;
		for (const v of [...doubled, 100]) sum += v;
		console.log(doubled.join("-"), sum);
	`,
	control: `
		function risky(n) {
			try {
				if (n < 0) throw new RangeError("neg");
				return n * 2;
			} catch (e) {
				return e.message;
			} finally {
				console.log("cleanup", n);
			}
		}
		console.log(risky(5), risky(-1));
	`,
	bigint: `
		const big = 2n ** 100n + 7n;
		console.log(big.toString(), typeof big, (big + 1n).toString());
	`,
	generators: `
		function* gen() { yield 1; yield 2; yield 3; }
		console.log([...gen()].join(","));
		class Point { #x = 3; getX() { return this.#x; } }
		console.log(new Point().getX());
	`,
};

// A silent base program (no output) with its own functions, globals, and string
// constants, so a splice of a fixture on top of it lands at nonzero function /
// global / string bases — exercising the rebasing.
const BASE_FIXTURE = `
	let baseAcc = 0;
	function baseHelper(x) { return x * 10 + baseAcc; }
	const baseLabel = "marker";
	baseAcc = baseHelper(2);
`;

interface RunResult {
	stdout: string;
	code: number;
	error?: string;
}

function run(cmd: string, args: Array<string>): RunResult {
	try {
		const stdout = execFileSync(cmd, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { stdout, code: 0 };
	} catch (error) {
		const e = error as { code?: string; stdout?: string; status?: number };
		return {
			stdout: e.stdout ?? "",
			code: e.status ?? 1,
			error: e.code === "ENOENT" ? `command not found: ${cmd}` : undefined,
		};
	}
}

function build(jsPath: string, name: string): string {
	const output = execFileSync("node", ["src/index.ts", "build", jsPath, "--name", name], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	// buildLocalBinary appends a content hash to --name, so read the path it printed.
	const match = output.match(/^Binary: (.+)$/m);
	if (match === null) {
		throw new Error(`no binary path in build output:\n${output}`);
	}
	return path.resolve(match[1]!);
}

const driver = buildLoadDriver(false, {
	kind: "source",
	sourceDirectory: path.resolve("src"),
	entrypoint: path.resolve("src/eval-compiler-entry.mts"),
	bake: () =>
		compileEntrypointToBuffer(path.resolve("src/eval-compiler-entry.mts"), {
			stripTypes: stripTypesWithTypeScript,
		}),
});
const dir = mkdtempSync(path.join(tmpdir(), "mal-eval-"));

// Serialize the silent base once for the splice check.
const baseJs = path.join(dir, "_base.js");
const baseMalw = path.join(dir, "_base.malw");
writeFileSync(baseJs, BASE_FIXTURE);
run("node", ["src/index.ts", "build", baseJs, "--serialize", baseMalw]);

let failures = 0;
for (const [name, source] of Object.entries(FIXTURES)) {
	const jsPath = path.join(dir, `${name}.js`);
	const malwPath = path.join(dir, `${name}.malw`);
	writeFileSync(jsPath, source);

	// C-baked path (the reference).
	let baked: RunResult;
	try {
		const binary = build(jsPath, `evalchk_${name}`);
		baked = run(binary, []);
	} catch (error) {
		const e = error as { message?: string; status?: number };
		baked = {
			stdout: "",
			code: -1,
			error: `build failed${e.status === undefined ? "" : ` (exit ${e.status})`}: ${e.message ?? String(error)}`,
		};
	}

	// Loaded path (wire format, base 0) and spliced path (nonzero bases).
	run("node", ["src/index.ts", "build", jsPath, "--serialize", malwPath]);
	const loaded = run(driver, [malwPath]);
	const spliced = run(driver, ["--splice", baseMalw, malwPath]);

	const ok =
		baked.error === undefined &&
		baked.stdout === loaded.stdout &&
		baked.code === loaded.code &&
		baked.stdout === spliced.stdout &&
		baked.code === spliced.code;
	if (ok) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}`);
		console.log(
			`    baked   (exit ${baked.code}): ${JSON.stringify(baked.stdout)}${baked.error === undefined ? "" : ` (${baked.error})`}`,
		);
		console.log(`    loaded  (exit ${loaded.code}): ${JSON.stringify(loaded.stdout)}`);
		console.log(`    spliced (exit ${spliced.code}): ${JSON.stringify(spliced.stdout)}`);
	}
}

console.log(
	failures === 0
		? `\nall ${Object.keys(FIXTURES).length} fixtures match`
		: `\n${failures} fixture(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
