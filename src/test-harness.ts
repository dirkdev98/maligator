/**
 * Shared native test harness. The feature-acceptance tests (web globals, URL, GC,
 * fibers, reactor, sockets, HTTP, host event loop, servers, fetch) all build a JS
 * fixture into a real isolate binary and run it; this module owns that pipeline so
 * the tests stay declarative.
 *
 * Two responsibilities beyond deduplication:
 *   - ordinary fixture frontends, generated objects, linked binaries, and the
 *     expensive C/Rust archives are atomically cached in the shared user cache;
 *     only the emitted `.c` and restored binary land in the caller's `outDir`.
 *   - the plain + MAL_GC_STRESS+MAL_GC_VERIFY re-run that every runner used to
 *     copy-paste is one constant ({@link STRESS_ENV}) plus small assert helpers.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as path from "node:path";
import { includeConfiguredAssets } from "./assets.ts";
import { buildDerivationFromConfig, resolveBuildConfig } from "./build-config.ts";
import type { ResolvedBuildConfig } from "./build-config.ts";
import { normalizeNativeFeatures } from "./build-flags.ts";
import { compileBuildFrontend } from "./build-frontend-cache.ts";
import { stripCompactTypes, TYPE_STRIPPER_IDENTITY } from "./compact-type-strip.ts";
import { compileSemanticProgramToVmDefinition } from "./compile-core.ts";
import { compileEntrypointToBuffer } from "./compile-program.ts";
import { compilerEntrypointSourceFiles } from "./compiler-bake.ts";
import type { CompilerBakeInput } from "./compiler-bake.ts";
import { compilerProgramFactsFromConfig } from "./compiler-facts.ts";
import { emitVmDefinition } from "./emit-vm.ts";
import { buildLocalBinary } from "./local-build.ts";
import type { LocalBuildResult } from "./local-build.ts";
import type { ModuleGoal } from "./module-graph.ts";
import { resolveNativeBuildContext } from "./native-build-context.ts";
import type { MaligatorIntlFeature } from "./public-api.d.ts";
import { loadEntrypointAndRunSemanticAnalysis } from "./semantic-program.ts";

/** Entry-point C drivers linked with the emitted definition. */
export const HOST_MAIN = "runtime/host_main.c";
export const FIBER_MAIN = "runtime/fiber_test_main.c";
export const REACTOR_MAIN = "runtime/reactor_test_main.c";
export const NET_MAIN = "runtime/net_test_main.c";
export const HTTP_MAIN = "runtime/http_test_main.c";
export const SERVER_MAIN = "runtime/server_test_main.c";
export const ARGON2_MAIN = "runtime/argon2_test_main.c";
export const ENTROPY_MAIN = "runtime/entropy_test_main.c";
export const SECRET_BUFFER_MAIN = "runtime/secret_buffer_test_main.c";
/** Host entry with a one-worker, one-slot, deliberately-slow Argon2 pool. */
export const CRYPTO_START_FAILURE_MAIN = "runtime/crypto_start_failure_test_main.c";

const compilerSourceDirectory = path.resolve("src");
const compilerEntrypoint = path.resolve("src/eval-compiler-entry.mts");
let compilerSourceFiles: Array<string> | undefined;

function defaultCompilerBake(): CompilerBakeInput {
	// Harness-only edits must not rebake the eval compiler; key its actual import cone.
	compilerSourceFiles ??= compilerEntrypointSourceFiles(
		compilerSourceDirectory,
		compilerEntrypoint,
		stripCompactTypes,
	);
	return {
		kind: "source",
		sourceDirectory: compilerSourceDirectory,
		entrypoint: compilerEntrypoint,
		sourceFiles: compilerSourceFiles,
		bake: () =>
			compileEntrypointToBuffer(compilerEntrypoint, {
				stripTypes: stripCompactTypes,
			}),
	};
}

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
	/** Explicit entry parse goal for fixtures whose semantics are script-specific. */
	entryGoal?: ModuleGoal;
	/** C driver to link; defaults to the test262 harness main. */
	mainFile?: string;
	/** Artifact directory; defaults to `.cache/mal-build`. Pass a temp dir under vitest. */
	outDir?: string;
	/**
	 * Include runtime eval / new Function (embed the baked compiler). Defaults to
	 * true — internal tooling opts in. Set false to build the runtime-disabled
	 * `engine.eval: false` / `"compile-check"` archive (no compiler embed;
	 * eval/Function throw EvalError at runtime).
	 */
	evalEnabled?: boolean;
	/**
	 * Include the Realm surface. Defaults to true — internal tooling opts in. Set
	 * false to build the `engine.realms: false` archive (`-DMAL_REALMS=0`).
	 */
	realmsEnabled?: boolean;
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
	intlFeatures?: Array<MaligatorIntlFeature>;
	/**
	 * Include the broader web surface. Defaults to true — internal tooling opts in.
	 * With Node also disabled, false drops ada / URL and the C++ runtime link.
	 */
	webPlatformEnabled?: boolean;
	/** Include the Node compatibility surface. Defaults to false. */
	nodeEnabled?: boolean;
	/**
	 * Include the RegExp engine (regress). Defaults to true. Set false to build the
	 * `engine.regexp: false` archive (no regress; RegExp uninstalled, String regex
	 * methods throw).
	 */
	regexpEnabled?: boolean;
	/** Include Temporal and its calendar/time-zone data. Defaults to true internally. */
	temporalEnabled?: boolean;
	/** Compile the production profile recorder into this native fixture. */
	profileEnabled?: boolean;
	/**
	 * A fully-resolved build config to build under. When provided it wins over the
	 * flat `evalEnabled` / `intlEnabled` / `intlFeatures` / `webPlatformEnabled` /
	 * `nodeEnabled`
	 * fields (used by the size bench to build a matrix of real config profiles);
	 * otherwise a config is reconstructed from those flags.
	 */
	config?: ResolvedBuildConfig;
	/** Override the eval compiler source, primarily for explicit prebuilt-wire checks. */
	compilerBake?: CompilerBakeInput;
	/** Override native build environment, primarily for compile-time instrument tests. */
	environment?: NodeJS.ProcessEnv;
	/** Observe persistent frontend-cache reuse in focused harness tests. */
	onFrontendCacheEvent?: (event: { cache: "hit" | "miss"; entrypoint: string }) => void;
}

export type BuildNativeBinaryResult = LocalBuildResult;

/**
 * Compile a fixture through the full pipeline (semantic → ir → opt → regalloc →
 * lower → emit) and link it into a runnable binary. Returns the binary path.
 */
export function buildNativeBinary(options: BuildOptions): string {
	return buildNativeBinaryResult(options).binaryPath;
}

/** Compile and link a fixture, retaining the exact context and linked artifacts. */
export function buildNativeBinaryResult(options: BuildOptions): BuildNativeBinaryResult {
	// Reuse the real build-config resolution so semantic capabilities and
	// output suffix, Cargo features, and C defines match the CLI exactly.
	const config =
		options.config ??
		resolveBuildConfig({
			engine: {
				primordials: "mutable",
				eval: options.evalEnabled ?? true,
				realms: options.realmsEnabled ?? true,
				regexp: options.regexpEnabled ?? true,
				temporal: options.temporalEnabled ?? true,
				intl: {
					enabled: options.intlEnabled ?? true,
					features: options.intlFeatures ?? [],
				},
			},
			surface: {
				webPlatform: options.webPlatformEnabled ?? true,
				node: options.nodeEnabled ?? false,
			},
		});
	const entrypoint = path.resolve(options.fixture);
	const canReuseFrontend =
		options.entryGoal === undefined && options.profileEnabled !== true;
	const definition = canReuseFrontend
		? (() => {
				const frontend = compileBuildFrontend({
					entrypoint,
					config,
					stripTypes: stripCompactTypes,
					stripperIdentity: TYPE_STRIPPER_IDENTITY,
					enforcePolicies: false,
				});
				options.onFrontendCacheEvent?.({
					cache: frontend.cache,
					entrypoint,
				});
				return frontend.definition;
			})()
		: (() => {
				const semanticProgram = loadEntrypointAndRunSemanticAnalysis(entrypoint, {
					buildConfig: config,
					stripTypes: stripCompactTypes,
					entryGoal: options.entryGoal,
				});
				// Tests intentionally bypass build policy so disabled-feature fixtures can
				// compile and assert the runtime behavior of the reduced engine.
				return compileSemanticProgramToVmDefinition(semanticProgram, {
					facts: compilerProgramFactsFromConfig(config),
					profile: options.profileEnabled,
				});
			})();
	const cSource = emitVmDefinition(definition, {
		compiled: options.compiled ?? true,
		assets: includeConfiguredAssets(config.assets),
		maligatorSurface: config.surface.maligator,
	});
	const baseDerivation = buildDerivationFromConfig(config);
	const derivation = options.profileEnabled
		? {
				features: normalizeNativeFeatures({
					...baseDerivation.features,
					profileEnabled: true,
				}),
				cacheSuffix:
					baseDerivation.cacheSuffix === ""
						? "profile"
						: `${baseDerivation.cacheSuffix}-profile`,
			}
		: baseDerivation;
	const context = resolveNativeBuildContext({
		features: derivation.features,
		environment: options.environment,
		compilerBake: options.compilerBake ?? defaultCompilerBake(),
	});
	return buildLocalBinary({
		context,
		name: options.name,
		cSource,
		verbose: false,
		mainFile: options.mainFile,
		outDir: options.outDir,
		cacheSuffix: derivation.cacheSuffix,
	});
}

export interface RunOptions {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export function scaledNativeRunTimeoutMs(
	timeoutMs = 20000,
	env: NodeJS.ProcessEnv = process.env,
): number {
	return env.MAL_ASAN === "1" || env.MAL_UBSAN === "1" ? timeoutMs * 3 : timeoutMs;
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
		Object.defineProperty(this, "name", { value: "RunError", configurable: true });
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

/**
 * Run a built binary to completion and return its stdout. Throws {@link RunError}
 * (with both streams) on a non-zero exit, timeout, or spawn failure.
 */
export function runToStdout(binary: string, options: RunOptions = {}): string {
	const env = { ...process.env, ...options.env };
	try {
		return execFileSync(binary, {
			env,
			encoding: "utf-8",
			timeout: scaledNativeRunTimeoutMs(options.timeoutMs, env),
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

/** Capture exit immediately so a later bounded wait cannot miss a fast child. */
export function captureChildExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
}

/** Start the timeout only when the caller expects the captured child to exit. */
export async function waitForChildExit(
	exit: Promise<number | null>,
	timeoutMs = 15000,
): Promise<number | null> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			exit,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("server did not exit")), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
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
