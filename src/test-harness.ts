/**
 * Shared native test harness. The feature-acceptance tests (web globals, URL, GC,
 * fibers, reactor, sockets, HTTP, host event loop, servers, fetch) all build a JS
 * fixture into a real isolate binary and run it; this module owns that pipeline so
 * the tests stay declarative.
 *
 * Two responsibilities beyond deduplication:
 *   - the expensive part (the three runtime archives) is built once by
 *     {@link buildNativeBinary}'s callee and cached under `.cache/local/lib`; only
 *     the per-test emitted `.c` + final link land in the caller-chosen `outDir`, so
 *     parallel vitest workers never clobber each other.
 *   - the plain + MAL_GC_STRESS+MAL_GC_VERIFY re-run that every runner used to
 *     copy-paste is one constant ({@link STRESS_ENV}) plus small assert helpers.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { buildDerivationFromConfig, resolveBuildConfig } from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { emitVmDefinition } from "./emit-vm.ts";
import { executeIROptimizations } from "./ir-opt.ts";
import { compileSemanticProgramToIr } from "./ir.ts";
import { buildLocalBinary } from "./local-build.ts";
import { lowerIrProgramToVmDefinition } from "./lower-vm.ts";
import { allocateRegisters } from "./register-alloc.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-program.ts";

/** Entry-point C drivers linked with the emitted definition. */
export const HOST_MAIN = "runtime/host_main.c";
export const FIBER_MAIN = "runtime/fiber_test_main.c";
export const REACTOR_MAIN = "runtime/reactor_test_main.c";
export const NET_MAIN = "runtime/net_test_main.c";
export const HTTP_MAIN = "runtime/http_test_main.c";
export const SERVER_MAIN = "runtime/server_test_main.c";

/**
 * Collect at every safepoint + poison freed cells: GCs land while callbacks,
 * suspended fibers, and in-flight promise reactions are live, so a missed root
 * corrupts loudly. The near-universal second run for every native test.
 */
export const STRESS_ENV: NodeJS.ProcessEnv = { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" };

export interface BuildOptions {
	/** Path to the JS/TS entry fixture. */
	fixture: string;
	/** Base name for the emitted `.c` and linked binary. */
	name: string;
	/** Native codegen (default) vs the bytecode interpreter (Tier B root walk). */
	compiled?: boolean;
	/** C driver to link; defaults to the test262 harness main. */
	mainFile?: string;
	/** Artifact directory; defaults to `.cache/local`. Pass a temp dir under vitest. */
	outDir?: string;
	/** Link against pre-built archives (set by the vitest native lane's globalSetup). */
	skipRuntimeBuild?: boolean;
	/**
	 * Include runtime eval / new Function (embed the baked compiler). Defaults to
	 * true — internal tooling opts in. Set false to build the `engine.eval: false`
	 * archive (no compiler embed, eval/Function throw EvalError at runtime).
	 */
	evalEnabled?: boolean;
	/**
	 * Include the Intl (ICU4X) surface. Defaults to true. Set false to build the
	 * `engine.intl: false` archive (no ICU crates / baked CLDR data, no Intl global).
	 */
	intlEnabled?: boolean;
	/**
	 * Selected Intl services (engine.intl.features service names); omitted/[] = all.
	 * A subset drops the rest's icu sub-crate + baked data. Ignored if intlEnabled is
	 * false.
	 */
	intlFeatures?: Array<string>;
	/**
	 * Include the WHATWG URL (ada) surface. Defaults to true — internal tooling opts
	 * in. Set false to build the `surface.webPlatform: false` archive (no ada / URL,
	 * no `-lc++`).
	 */
	webPlatformEnabled?: boolean;
	/**
	 * Include the RegExp engine (regress). Defaults to true. Set false to build the
	 * `engine.regexp: false` archive (no regress; RegExp uninstalled, String regex
	 * methods throw).
	 */
	regexpEnabled?: boolean;
	/**
	 * A fully-resolved build config to build under. When provided it wins over the
	 * flat `evalEnabled` / `intlEnabled` / `intlFeatures` / `webPlatformEnabled`
	 * fields (used by the size bench to build a matrix of real config profiles);
	 * otherwise a config is reconstructed from those flags.
	 */
	config?: ResolvedBuildConfig;
}

/**
 * Compile a fixture through the full pipeline (semantic → ir → opt → regalloc →
 * lower → emit) and link it into a runnable binary. Returns the binary path.
 */
export function buildNativeBinary(options: BuildOptions): string {
	const semanticProgram = loadEntrypointAndRunSemanticAnalysis(
		path.resolve(options.fixture),
	);
	const ir = compileSemanticProgramToIr(semanticProgram);
	executeIROptimizations(ir);
	allocateRegisters(ir);
	const definition = lowerIrProgramToVmDefinition(ir);
	const cSource = emitVmDefinition(definition, { compiled: options.compiled ?? true });
	// Reuse the real build-config resolution so cache suffixes / cargo features / C
	// defines match the CLI exactly (canonical build → "" suffix → shared archives).
	const config =
		options.config ??
		resolveBuildConfig({
			engine: {
				eval: options.evalEnabled ?? true,
				regexp: options.regexpEnabled ?? true,
				intl: {
					enabled: options.intlEnabled ?? true,
					features: options.intlFeatures ?? [],
				},
			},
			surface: { webPlatform: options.webPlatformEnabled ?? true },
		});
	return buildLocalBinary({
		name: options.name,
		cSource,
		verbose: false,
		mainFile: options.mainFile,
		outDir: options.outDir,
		skipRuntimeBuild: options.skipRuntimeBuild,
		...buildDerivationFromConfig(config),
	});
}

export interface RunOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

/** An error carrying the child's captured streams, so a failing test shows them. */
export class RunError extends Error {
	stdout: string;
	stderr: string;

	constructor(message: string, stdout: string, stderr: string) {
		super(
			stderr.trim()
				? `${message}\n${stdout.trim()}\n${stderr.trim()}`
				: `${message}\n${stdout.trim()}`,
		);
		this.name = "RunError";
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

/**
 * Run a built binary to completion and return its stdout. Throws {@link RunError}
 * (with both streams) on a non-zero exit, timeout, or spawn failure.
 */
export function runToStdout(binary: string, options: RunOptions = {}): string {
	try {
		return execFileSync(binary, {
			env: { ...process.env, ...options.env },
			encoding: "utf-8",
			timeout: options.timeoutMs ?? 20000,
		});
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		throw new RunError(
			`binary exited non-zero: ${binary}`,
			e.stdout ?? "",
			e.stderr ?? "",
		);
	}
}

/** Non-empty, trimmed lines of `stdout`. */
function nonEmptyLines(stdout: string): Array<string> {
	return stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/**
 * Assert a `<tag> PASS N/N` line with N === N (the fiber/reactor/net/http/gc
 * driver protocol). Returns the count for logging. Throws on mismatch.
 */
export function assertPassLine(stdout: string, tag: string): number {
	const match = stdout.match(new RegExp(`${tag} PASS (\\d+)/(\\d+)`));
	if (!match || match[1] !== match[2] || Number(match[2]) === 0) {
		throw new Error(`${tag}: expected a full "PASS N/N" line, got:\n${stdout.trim()}`);
	}
	return Number(match[2]);
}

/**
 * Assert the fixture's own `RESULT N/N` reports a full pass with no `FAIL:` lines
 * (the web-globals / URL fixture protocol). Throws with the failures on mismatch.
 */
export function assertResultPass(stdout: string): string {
	const lines = nonEmptyLines(stdout);
	const failures = lines.filter((l) => l.startsWith("FAIL:"));
	const result = lines.find((l) => l.startsWith("RESULT "));
	const m = result?.match(/RESULT (\d+)\/(\d+)/) ?? null;
	const ok = failures.length === 0 && m !== null && m[1] === m[2] && Number(m[2]) > 0;
	if (!ok) {
		const detail = [...failures, `result line: ${result ?? "(none)"}`].join("\n  ");
		throw new Error(`expected a clean RESULT line, got:\n  ${detail}`);
	}
	return result!;
}

/** Assert stdout's non-empty lines match `expected` exactly, in order. */
export function assertExactLines(stdout: string, expected: Array<string>): void {
	const lines = nonEmptyLines(stdout);
	const ok = lines.length === expected.length && lines.every((l, i) => l === expected[i]);
	if (!ok) {
		throw new Error(
			`stdout line mismatch:\n  got: ${JSON.stringify(lines)}\n  exp: ${JSON.stringify(expected)}`,
		);
	}
}

/**
 * Spawn a server binary and resolve its ephemeral port from the first `PORT <n>`
 * line it prints. Rejects on early exit or timeout. The caller drives it with
 * `fetch` and must `child.kill()` when done (use {@link withServer}).
 */
export function waitForPort(child: ChildProcess, timeoutMs = 15000): Promise<number> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(
			() => reject(new Error("timeout waiting for PORT")),
			timeoutMs,
		);
		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString();
			const m = buf.match(/PORT (\d+)/);
			if (m) {
				clearTimeout(timer);
				resolve(Number(m[1]));
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`server exited early (code ${code})`));
		});
	});
}

/**
 * Spawn a server binary, wait for its port, run `body(baseUrl)`, and always kill
 * the child. Captures stderr and attaches it to a failure from `body`.
 */
export async function withServer<T>(
	binary: string,
	env: NodeJS.ProcessEnv,
	body: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const child = spawn(binary, [], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});
	let stderr = "";
	child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
	try {
		const port = await waitForPort(child);
		return await body(`http://127.0.0.1:${port}`);
	} catch (error) {
		throw new RunError(`server test failed: ${(error as Error).message}`, "", stderr);
	} finally {
		child.kill("SIGKILL");
	}
}
