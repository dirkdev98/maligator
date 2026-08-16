import { execFileSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

const CACHE_SCHEMA = 8;
const C2X_FLAGS = ["-std=c2x"];
const LTO_FLAG_CANDIDATES = [["-flto=thin"], ["-flto"]];

export interface ToolExecutable {
	path: string;
	version: string;
	/** Arguments selecting a subcommand/target before invocation-specific arguments. */
	args?: Array<string>;
}

export interface ToolchainTools {
	cc: ToolExecutable;
	cxx?: ToolExecutable;
	ar: ToolExecutable;
	rustup: ToolExecutable;
	cargo: ToolExecutable;
	rustc: ToolExecutable;
	strip?: ToolExecutable;
	zig?: ToolExecutable;
}

export interface ToolchainProbes {
	c2x: boolean;
	lto: boolean;
	ltoFlags: Array<string>;
	strip: boolean;
	cxxLink: boolean;
	stripArgs: Array<string>;
	cxxLinkArgs: Array<string>;
}

export interface ToolchainIssue {
	tool: string;
	message: string;
	required: boolean;
}

export interface Toolchain {
	tools: ToolchainTools;
	target: string;
	rustTarget: string;
	/** Target operating system; defaults to the host for legacy callers. */
	platform?: NodeJS.Platform;
	/** Whether the C/C++ stages are driven by Zig for an explicit target. */
	cross?: boolean;
	zigTarget?: string;
	/** Build-process environment required by the selected driver. */
	environmentOverrides?: Readonly<NodeJS.ProcessEnv>;
	probes: ToolchainProbes;
	fingerprint: string;
	cacheHit: boolean;
}

export interface ToolchainReport {
	tools: Partial<ToolchainTools>;
	target?: string;
	rustTarget?: string;
	platform?: NodeJS.Platform;
	cross?: boolean;
	zigTarget?: string;
	probes?: ToolchainProbes;
	fingerprint?: string;
	cacheHit: boolean;
	issues: Array<ToolchainIssue>;
	toolchain?: Toolchain;
}

export interface InspectToolchainOptions {
	rootDir?: string;
	rustDir?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	arch?: string;
	needsCxx?: boolean;
	/** Rust target triple. Explicit targets are cross-built through Zig. */
	target?: string;
}

interface ZigCrossTarget {
	rustTarget: string;
	zigTarget: string;
	platform: "darwin" | "linux";
	arch: "arm64" | "x64";
}

const ZIG_CROSS_TARGETS: Record<string, Omit<ZigCrossTarget, "rustTarget">> = {
	"aarch64-apple-darwin": {
		zigTarget: "aarch64-macos",
		platform: "darwin",
		arch: "arm64",
	},
	"x86_64-apple-darwin": {
		zigTarget: "x86_64-macos",
		platform: "darwin",
		arch: "x64",
	},
	"aarch64-unknown-linux-gnu": {
		zigTarget: "aarch64-linux-gnu",
		platform: "linux",
		arch: "arm64",
	},
	"x86_64-unknown-linux-gnu": {
		zigTarget: "x86_64-linux-gnu",
		platform: "linux",
		arch: "x64",
	},
};

export const SUPPORTED_ZIG_CROSS_TARGETS = Object.freeze(
	Object.keys(ZIG_CROSS_TARGETS).sort(),
);

export function resolveZigCrossTarget(rustTarget: string): ZigCrossTarget {
	const target = ZIG_CROSS_TARGETS[rustTarget];
	if (target === undefined) {
		throw new Error(
			`unsupported cross-build target '${rustTarget}'; supported targets: ${SUPPORTED_ZIG_CROSS_TARGETS.join(", ")}`,
		);
	}
	return { rustTarget, ...target };
}

/** Prefix a tool's fixed subcommand/target arguments. */
export function toolArguments(tool: ToolExecutable, args: Array<string>): Array<string> {
	return [...(tool.args ?? []), ...args];
}

/** Human-readable executable plus its fixed subcommand/target arguments. */
export function formatToolCommand(tool: ToolExecutable): string {
	return [tool.path, ...(tool.args ?? [])].join(" ");
}

interface CachedProbes {
	schema: number;
	fingerprint: string;
	probes: ToolchainProbes;
}

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function isCachedProbes(value: unknown, fingerprint: string): value is CachedProbes {
	if (typeof value !== "object" || value === null) return false;
	const cached = value as Partial<CachedProbes>;
	const probes = cached.probes as Partial<ToolchainProbes> | undefined;
	return (
		cached.schema === CACHE_SCHEMA &&
		cached.fingerprint === fingerprint &&
		probes !== undefined &&
		typeof probes.c2x === "boolean" &&
		typeof probes.lto === "boolean" &&
		Array.isArray(probes.ltoFlags) &&
		probes.ltoFlags.every((item) => typeof item === "string") &&
		typeof probes.strip === "boolean" &&
		typeof probes.cxxLink === "boolean" &&
		Array.isArray(probes.stripArgs) &&
		probes.stripArgs.every((item) => typeof item === "string") &&
		Array.isArray(probes.cxxLinkArgs) &&
		probes.cxxLinkArgs.every((item) => typeof item === "string")
	);
}

export class ToolchainError extends Error {
	report: ToolchainReport;

	constructor(report: ToolchainReport, platform: NodeJS.Platform = process.platform) {
		super(formatToolchainReport(report, platform));
		Object.defineProperty(this, "name", { value: "ToolchainError", configurable: true });
		this.report = report;
	}
}

function run(
	executable: string,
	args: Array<string>,
	options: { cwd?: string; env: NodeJS.ProcessEnv },
): CommandResult {
	try {
		const stdout = execFileSync(executable, args, {
			cwd: options.cwd,
			env: options.env,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "" };
	} catch (error) {
		const result = error as { message?: string; stderr?: string; stdout?: string };
		return {
			ok: false,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? result.message ?? "",
		};
	}
}

function resolveExecutable(
	name: string,
	searchPath: string,
	cwd: string,
): string | undefined {
	const candidates = name.includes(path.sep)
		? [path.resolve(cwd, name)]
		: searchPath
				.split(path.delimiter)
				.map((directory) => path.join(directory || ".", name));
	for (const candidate of candidates) {
		try {
			const stats = statSync(candidate);
			if (stats.isFile() && (stats.mode & 0o111) !== 0) return realpathSync(candidate);
		} catch {
			// Continue through PATH.
		}
	}
	return undefined;
}

/** Resolve an executable from exactly the supplied PATH. */
export function resolvePathExecutable(
	name: string,
	searchPath = process.env.PATH ?? "",
): string {
	for (const directory of searchPath.split(path.delimiter)) {
		const candidate = path.join(directory || ".", name);
		try {
			const stats = statSync(candidate);
			if (stats.isFile() && (stats.mode & 0o111) !== 0) return candidate;
		} catch {
			// Continue through PATH.
		}
	}
	throw new Error(`required executable '${name}' was not found on PATH`);
}

function firstLine(value: string): string {
	return value.trim().split(/\r?\n/, 1)[0] ?? "unknown version";
}

function inspectExecutable(
	name: string,
	searchPath: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	versionArgs = ["--version"],
	allowUnknownVersion = false,
): ToolExecutable | undefined {
	const executable = resolveExecutable(name, searchPath, cwd);
	if (executable === undefined) return undefined;
	const result = run(executable, versionArgs, { cwd, env });
	if (!result.ok && !allowUnknownVersion) return undefined;
	return {
		path: executable,
		version: result.ok
			? firstLine(result.stdout || result.stderr)
			: "version unavailable",
	};
}

function selectedRustTool(
	rustup: ToolExecutable,
	name: "cargo" | "rustc",
	rustDir: string,
	env: NodeJS.ProcessEnv,
): ToolExecutable | undefined {
	const selected = run(rustup.path, toolArguments(rustup, ["which", name]), {
		cwd: rustDir,
		env,
	});
	if (!selected.ok) return undefined;
	const selectedPath = selected.stdout.trim();
	if (!selectedPath) return undefined;
	return inspectExecutable(selectedPath, env.PATH ?? "", rustDir, env);
}

function executableIdentity(tool: ToolExecutable): object {
	const stats = statSync(tool.path);
	return {
		path: realpathSync(tool.path),
		version: tool.version,
		args: tool.args ?? [],
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}

function fingerprintFor(
	tools: ToolchainTools,
	target: string,
	rustTarget: string,
	platform: NodeJS.Platform,
	arch: string,
	needsCxx: boolean,
): string {
	const testedFlags = {
		c2x: C2X_FLAGS,
		lto: LTO_FLAG_CANDIDATES,
		strip:
			tools.strip?.args?.[0] === "objcopy"
				? [["-s"]]
				: platform === "darwin"
					? [["-x"], ["-S"]]
					: [["--strip-all"], ["-s"]],
		cxxLink: needsCxx ? [["-lc++"], ["-lstdc++"]] : [],
	};
	const identities = Object.fromEntries(
		Object.entries(tools)
			.filter((entry): entry is [string, ToolExecutable] => entry[1] !== undefined)
			.map(([name, tool]) => [name, executableIdentity(tool)]),
	);
	return hash(
		"sha256",
		JSON.stringify({
			schema: CACHE_SCHEMA,
			platform,
			arch,
			needsCxx,
			target,
			rustTarget,
			testedFlags,
			identities,
		}),
		"hex",
	);
}

function compile(
	cc: ToolExecutable,
	args: Array<string>,
	cwd: string,
	env: NodeJS.ProcessEnv,
): boolean {
	return run(cc.path, toolArguments(cc, args), { cwd, env }).ok;
}

function probeCapabilities(
	tools: ToolchainTools,
	probeDir: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	needsCxx: boolean,
): ToolchainProbes {
	// The runtime relies on real C23, not just the __STDC_VERSION__ stamp: the
	// bool/true/false keywords with no <stdbool.h> (defaults.h), nullptr, and
	// #embed (compiler_wire.c inlines the baked compiler). GCC 12 accepts
	// -std=c2x and sets __STDC_VERSION__ to 202000L but supports none of these, so
	// probe the features themselves or the macro would green-light a compiler the
	// build then fails on deep inside the runtime archive.
	writeFileSync(path.join(probeDir, "c2x-embed.bin"), "mal");
	writeFileSync(
		path.join(probeDir, "main.c"),
		[
			"#if !defined(__STDC_VERSION__) || __STDC_VERSION__ < 202000L",
			"#error C2x required",
			"#endif",
			"static const unsigned char mal_probe_embed[] = {",
			'#embed "c2x-embed.bin"',
			"};",
			"int main(void) {",
			"  bool ok = true;",
			"  ok = false;",
			"  void *p = nullptr;",
			"  return (ok && p == nullptr && sizeof(mal_probe_embed) == 3) ? 0 : 1;",
			"}",
			"",
		].join("\n"),
	);
	const c2x = compile(
		tools.cc,
		[...C2X_FLAGS, "main.c", "-o", "c2x-probe"],
		probeDir,
		env,
	);

	writeFileSync(
		path.join(probeDir, "lto-lib.c"),
		"int mal_lto_probe(void) { return 0; }\n",
	);
	writeFileSync(
		path.join(probeDir, "lto-main.c"),
		"int mal_lto_probe(void); int main(void) { return mal_lto_probe(); }\n",
	);
	const probeLto = (flags: Array<string>): boolean => {
		const ltoCompile =
			compile(
				tools.cc,
				[...C2X_FLAGS, ...flags, "-c", "lto-lib.c", "-o", "lto-lib.o"],
				probeDir,
				env,
			) &&
			compile(
				tools.cc,
				[...C2X_FLAGS, ...flags, "-c", "lto-main.c", "-o", "lto-main.o"],
				probeDir,
				env,
			);
		const ltoArchive =
			ltoCompile &&
			run(
				tools.ar.path,
				toolArguments(tools.ar, ["rcs", "liblto-probe.a", "lto-lib.o"]),
				{ cwd: probeDir, env },
			).ok;
		return (
			ltoArchive &&
			compile(
				tools.cc,
				[...C2X_FLAGS, ...flags, "lto-main.o", "liblto-probe.a", "-o", "lto-probe"],
				probeDir,
				env,
			)
		);
	};
	let ltoFlags: Array<string> = [];
	for (const candidate of LTO_FLAG_CANDIDATES) {
		if (probeLto(candidate)) {
			ltoFlags = candidate;
			break;
		}
	}
	const lto = ltoFlags.length > 0;

	let cxxLink = !needsCxx;
	let cxxLinkArgs: Array<string> = [];
	if (needsCxx && tools.cxx !== undefined) {
		writeFileSync(
			path.join(probeDir, "cxx.cc"),
			'extern "C" int mal_cxx_probe(void) { int *p = new int(0); int n = *p; delete p; return n; }\n',
		);
		writeFileSync(
			path.join(probeDir, "cxx-main.c"),
			"int mal_cxx_probe(void); int main(void) { return mal_cxx_probe(); }\n",
		);
		const cxxObject = compile(tools.cxx, ["-c", "cxx.cc", "-o", "cxx.o"], probeDir, env);
		for (const args of [["-lc++"], ["-lstdc++"]]) {
			if (
				cxxObject &&
				compile(
					tools.cc,
					[...C2X_FLAGS, "cxx-main.c", "cxx.o", ...args, "-o", "cxx-probe"],
					probeDir,
					env,
				)
			) {
				cxxLink = true;
				cxxLinkArgs = args;
				break;
			}
		}
	}

	let strip = false;
	let stripArgs: Array<string> = [];
	if (tools.strip !== undefined && c2x) {
		if (tools.strip.args?.[0] === "objcopy") {
			// Zig objcopy can reject large LTO ELFs even after succeeding on a
			// probe-sized binary. Probe and use the cc driver's link-time strip.
			stripArgs = ["-s"];
			strip = compile(
				tools.cc,
				[...C2X_FLAGS, "main.c", ...stripArgs, "-o", "strip-probe"],
				probeDir,
				env,
			);
			if (!strip) stripArgs = [];
		} else {
			const candidates =
				platform === "darwin" ? [["-x"], ["-S"]] : [["--strip-all"], ["-s"]];
			for (const args of candidates) {
				copyFileSync(
					path.join(probeDir, "c2x-probe"),
					path.join(probeDir, "strip-probe"),
				);
				if (
					run(tools.strip.path, toolArguments(tools.strip, [...args, "strip-probe"]), {
						cwd: probeDir,
						env,
					}).ok
				) {
					strip = true;
					stripArgs = args;
					break;
				}
			}
		}
	}

	return { c2x, lto, ltoFlags, strip, cxxLink, stripArgs, cxxLinkArgs };
}

function rustHostTarget(
	rustc: ToolExecutable,
	rustDir: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const result = run(rustc.path, toolArguments(rustc, ["-vV"]), { cwd: rustDir, env });
	if (!result.ok) return undefined;
	return /^host:\s*(.+)$/m.exec(result.stdout)?.[1];
}

function rustTargetInstalled(
	rustc: ToolExecutable,
	rustTarget: string,
	rustDir: string,
	env: NodeJS.ProcessEnv,
): boolean {
	const result = run(
		rustc.path,
		toolArguments(rustc, ["--print", "target-libdir", "--target", rustTarget]),
		{ cwd: rustDir, env },
	);
	if (!result.ok) return false;
	const targetLibDir = result.stdout.trim();
	if (!targetLibDir) return false;
	try {
		return statSync(targetLibDir).isDirectory();
	} catch {
		return false;
	}
}

function addMissingIssue(
	issues: Array<ToolchainIssue>,
	tool: string,
	detail: string,
	required = true,
): void {
	issues.push({ tool, message: detail, required });
}

export function inspectToolchain(options: InspectToolchainOptions = {}): ToolchainReport {
	const rootDir = path.resolve(options.rootDir ?? process.cwd());
	const rustDir = path.resolve(options.rustDir ?? path.join(rootDir, "runtime/rust"));
	let env = options.env ?? process.env;
	const searchPath = env.PATH ?? "";
	const hostPlatform = options.platform ?? process.platform;
	const hostArch = options.arch ?? process.arch;
	const needsCxx = options.needsCxx ?? true;
	const issues: Array<ToolchainIssue> = [];
	const tools: Partial<ToolchainTools> = {};
	let crossTarget: ZigCrossTarget | undefined;
	if (options.target !== undefined) {
		try {
			crossTarget = resolveZigCrossTarget(options.target);
		} catch (error) {
			addMissingIssue(
				issues,
				"target",
				error instanceof Error ? error.message : String(error),
			);
			return { tools, cacheHit: false, issues, cross: true };
		}
	}
	const platform = crossTarget?.platform ?? hostPlatform;
	const arch = crossTarget?.arch ?? hostArch;
	const environmentOverrides: NodeJS.ProcessEnv = {};
	if (crossTarget !== undefined) {
		const zigCacheRoot = path.join(rootDir, ".cache/mal-cache/zig");
		environmentOverrides.ZIG_GLOBAL_CACHE_DIR =
			env.ZIG_GLOBAL_CACHE_DIR ?? path.join(zigCacheRoot, "global");
		environmentOverrides.ZIG_LOCAL_CACHE_DIR =
			env.ZIG_LOCAL_CACHE_DIR ?? path.join(zigCacheRoot, "local");
		env = { ...env, ...environmentOverrides };
	}

	const zigName = env.ZIG?.trim() || "zig";
	const zig = inspectExecutable(zigName, searchPath, rootDir, env, ["version"]);
	if (zig !== undefined) tools.zig = zig;

	if (crossTarget !== undefined) {
		if (zig === undefined) {
			addMissingIssue(
				issues,
				"zig",
				env.ZIG
					? `ZIG points to an unavailable executable: ${env.ZIG}`
					: "Zig was not found on PATH (required for cross-builds)",
			);
		} else {
			tools.cc = {
				path: zig.path,
				version: `zig cc ${zig.version}`,
				args: ["cc", "-target", crossTarget.zigTarget],
			};
			if (needsCxx) {
				tools.cxx = {
					path: zig.path,
					version: `zig c++ ${zig.version}`,
					args: ["c++", "-target", crossTarget.zigTarget],
				};
			}
			tools.ar = { path: zig.path, version: `zig ar ${zig.version}`, args: ["ar"] };
			tools.strip = {
				path: zig.path,
				version: `zig objcopy ${zig.version}`,
				args: ["objcopy"],
			};
		}
	} else {
		const ccName = env.CC?.trim() || "cc";
		const cc = inspectExecutable(ccName, searchPath, rootDir, env);
		if (cc === undefined) {
			addMissingIssue(
				issues,
				"cc",
				env.CC
					? `CC points to an unavailable compiler: ${env.CC}`
					: "a C compiler was not found on PATH",
			);
		} else tools.cc = cc;

		if (needsCxx) {
			const cxxName = env.CXX?.trim() || "c++";
			const cxx = inspectExecutable(cxxName, searchPath, rootDir, env);
			if (cxx === undefined) {
				addMissingIssue(
					issues,
					"cxx",
					env.CXX
						? `CXX points to an unavailable compiler: ${env.CXX}`
						: "a C++ compiler was not found on PATH (required by the web-platform runtime)",
				);
			} else tools.cxx = cxx;
		}

		const ar = inspectExecutable("ar", searchPath, rootDir, env, ["--version"], true);
		if (ar === undefined)
			addMissingIssue(issues, "ar", "a static archive tool was not found on PATH");
		else tools.ar = ar;

		const strip = inspectExecutable(
			"strip",
			searchPath,
			rootDir,
			env,
			["--version"],
			true,
		);
		if (strip === undefined)
			addMissingIssue(issues, "strip", "symbol stripping is unavailable", false);
		else tools.strip = strip;
	}

	const rustup = inspectExecutable("rustup", searchPath, rustDir, env);
	if (rustup === undefined) {
		addMissingIssue(issues, "rustup", "rustup was not found on PATH");
	} else {
		tools.rustup = rustup;
		const cargo = selectedRustTool(rustup, "cargo", rustDir, env);
		const rustc = selectedRustTool(rustup, "rustc", rustDir, env);
		if (cargo === undefined) {
			addMissingIssue(
				issues,
				"cargo",
				"rustup could not select cargo for runtime/rust/rust-toolchain.toml",
			);
		} else tools.cargo = cargo;
		if (rustc === undefined) {
			addMissingIssue(
				issues,
				"rustc",
				"rustup could not select rustc for runtime/rust/rust-toolchain.toml",
			);
		} else tools.rustc = rustc;
	}

	const report: ToolchainReport = {
		tools,
		cacheHit: false,
		issues,
		platform,
		cross: crossTarget !== undefined,
		...(crossTarget === undefined ? {} : { zigTarget: crossTarget.zigTarget }),
	};
	if (
		crossTarget !== undefined &&
		tools.rustc !== undefined &&
		!rustTargetInstalled(tools.rustc, crossTarget.rustTarget, rustDir, env)
	) {
		addMissingIssue(
			issues,
			"rust-target",
			`Rust standard library target '${crossTarget.rustTarget}' is not installed`,
		);
	}
	if (
		tools.cc === undefined ||
		tools.ar === undefined ||
		tools.rustup === undefined ||
		tools.cargo === undefined ||
		tools.rustc === undefined ||
		(needsCxx && tools.cxx === undefined) ||
		issues.some((issue) => issue.required)
	) {
		if (crossTarget !== undefined) {
			report.rustTarget = crossTarget.rustTarget;
			report.target = crossTarget.zigTarget;
		}
		return report;
	}

	const completeTools: ToolchainTools = {
		cc: tools.cc,
		ar: tools.ar,
		rustup: tools.rustup,
		cargo: tools.cargo,
		rustc: tools.rustc,
		...(tools.cxx === undefined ? {} : { cxx: tools.cxx }),
		...(tools.strip === undefined ? {} : { strip: tools.strip }),
		...(tools.zig === undefined ? {} : { zig: tools.zig }),
	};
	const ccTargetResult = run(
		completeTools.cc.path,
		toolArguments(completeTools.cc, ["-dumpmachine"]),
		{
			cwd: rootDir,
			env,
		},
	);
	const target =
		ccTargetResult.ok && ccTargetResult.stdout.trim()
			? ccTargetResult.stdout.trim()
			: `${arch}-${platform}`;
	const rustTarget =
		crossTarget?.rustTarget ??
		rustHostTarget(completeTools.rustc, rustDir, env) ??
		"unknown";
	report.target = target;
	report.rustTarget = rustTarget;
	const fingerprint = fingerprintFor(
		completeTools,
		target,
		rustTarget,
		platform,
		arch,
		needsCxx,
	);
	report.fingerprint = fingerprint;
	const cacheDir = path.join(rootDir, ".cache/mal-cache/toolchains");
	const cachePath = path.join(cacheDir, `${fingerprint}.json`);
	let probes: ToolchainProbes | undefined;
	try {
		const cached: unknown = JSON.parse(readFileSync(cachePath, "utf-8"));
		if (isCachedProbes(cached, fingerprint)) {
			probes = cached.probes;
			report.cacheHit = true;
		}
	} catch {
		// A miss or malformed cache entry is replaced after probing.
	}
	if (probes === undefined) {
		mkdirSync(cacheDir, { recursive: true });
		const probeDir = mkdtempSync(path.join(cacheDir, "probe-"));
		try {
			probes = probeCapabilities(completeTools, probeDir, env, platform, needsCxx);
			writeFileSync(
				cachePath,
				`${JSON.stringify({ schema: CACHE_SCHEMA, fingerprint, probes } satisfies CachedProbes, null, 2)}\n`,
			);
		} finally {
			rmSync(probeDir, { recursive: true, force: true });
		}
	}
	report.probes = probes;
	if (!probes.c2x)
		addMissingIssue(issues, "cc", "the selected C compiler cannot compile and link C2x");
	if (needsCxx && !probes.cxxLink) {
		addMissingIssue(
			issues,
			"cxx",
			"the selected C/C++ toolchain cannot link the required C++ runtime",
		);
	}
	if (!probes.lto)
		addMissingIssue(issues, "lto", "compile/archive/link LTO is unavailable", false);
	if (tools.strip !== undefined && !probes.strip) {
		addMissingIssue(
			issues,
			"strip",
			"the host strip tool could not strip a linked artifact",
			false,
		);
	}
	if (issues.some((issue) => issue.required)) return report;

	const toolchain: Toolchain = {
		tools: completeTools,
		target,
		rustTarget,
		platform,
		cross: crossTarget !== undefined,
		...(crossTarget === undefined ? {} : { zigTarget: crossTarget.zigTarget }),
		...(crossTarget === undefined ? {} : { environmentOverrides }),
		probes,
		fingerprint,
		cacheHit: report.cacheHit,
	};
	report.toolchain = toolchain;
	return report;
}

export function requireToolchain(options: InspectToolchainOptions = {}): Toolchain {
	const report = inspectToolchain(options);
	if (report.toolchain === undefined) {
		throw new ToolchainError(
			report,
			report.platform ?? options.platform ?? process.platform,
		);
	}
	return report.toolchain;
}

function installationSuggestions(
	report: ToolchainReport,
	platform: NodeJS.Platform,
): Array<string> {
	const required = report.issues.filter((issue) => issue.required);
	const missing = new Set(required.map((issue) => issue.tool));
	const suggestions: Array<string> = [];
	// A present-but-too-old compiler fails the C2x capability probe rather than
	// being absent; build-essential/xcode won't help it, so only offer them when a
	// tool is genuinely missing from PATH.
	const absent = (tool: keyof ToolchainTools): boolean =>
		missing.has(tool) && report.tools[tool] === undefined;
	if (absent("cc") || absent("cxx") || absent("ar")) {
		if (platform === "darwin")
			suggestions.push("Install Apple build tools: xcode-select --install");
		else if (platform === "linux") {
			suggestions.push("Debian/Ubuntu: sudo apt install build-essential");
			suggestions.push("Fedora/RHEL: sudo dnf install gcc gcc-c++ binutils");
		}
	}
	if (required.some((issue) => issue.tool === "cc" && issue.message.includes("C2x"))) {
		suggestions.push(
			"The C compiler is too old for the C23 features the runtime uses (the bool/true/false keywords, nullptr, #embed).",
		);
		if (report.cross === true)
			suggestions.push("Update Zig and rerun the target-specific doctor check.");
		else if (platform === "linux")
			suggestions.push(
				"Install clang >= 19 (or gcc >= 15) and select it: sudo apt install clang-19 && export CC=clang-19 CXX=clang++-19",
			);
		else if (platform === "darwin")
			suggestions.push("Update the Apple command-line tools: xcode-select --install");
	}
	if (["rustup", "cargo", "rustc"].some((tool) => missing.has(tool))) {
		suggestions.push(
			"Install Rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
		);
		suggestions.push(
			"Then install the pinned toolchain: (cd runtime/rust && rustup show)",
		);
	}
	if (missing.has("zig")) {
		suggestions.push("Install Zig and ensure 'zig' is on PATH, or set ZIG.");
	}
	if (missing.has("rust-target") && report.rustTarget !== undefined) {
		suggestions.push(
			`Install the Rust target: (cd runtime/rust && rustup target add ${report.rustTarget})`,
		);
	}
	return suggestions;
}

function appendToolchainReportTail(
	lines: Array<string>,
	report: ToolchainReport,
	platform: NodeJS.Platform,
): void {
	const suggestions = installationSuggestions(report, platform);
	if (suggestions.length > 0)
		lines.push("", "Suggested fixes:", ...suggestions.map((item) => `  ${item}`));
	lines.push(
		"",
		report.toolchain === undefined ? "Toolchain is not ready." : "Toolchain is ready.",
	);
}

export function formatToolchainReport(
	report: ToolchainReport,
	platform: NodeJS.Platform = process.platform,
	verbose = false,
): string {
	const lines = ["Maligator native toolchain:"];
	if (!verbose) {
		const nativeReady =
			report.tools.cc !== undefined &&
			report.tools.cxx !== undefined &&
			report.tools.ar !== undefined &&
			report.tools.strip !== undefined &&
			report.probes?.c2x === true &&
			report.probes.cxxLink &&
			report.probes.lto &&
			report.probes.strip;
		const rustReady =
			report.tools.rustup !== undefined &&
			report.tools.cargo !== undefined &&
			report.tools.rustc !== undefined;
		if (nativeReady) lines.push("[ok] C compiler");
		if (rustReady) lines.push("[ok] Rust compiler");
		for (const issue of report.issues) {
			lines.push(
				`[${issue.required ? "missing" : "optional"}] ${issue.tool}: ${issue.message}`,
			);
		}
		appendToolchainReportTail(lines, report, platform);
		return lines.join("\n");
	}
	for (const name of [
		"zig",
		"cc",
		"cxx",
		"ar",
		"rustup",
		"cargo",
		"rustc",
		"strip",
	] as const) {
		const tool = report.tools[name];
		if (tool !== undefined)
			lines.push(`[ok] ${name}: ${formatToolCommand(tool)} (${tool.version})`);
		else {
			const issue = report.issues.find((candidate) => candidate.tool === name);
			if (issue !== undefined)
				lines.push(
					`[${issue.required ? "missing" : "optional"}] ${name}: ${issue.message}`,
				);
		}
	}
	if (report.cross === true) lines.push("[ok] build mode: Zig cross-build");
	if (report.zigTarget !== undefined) lines.push(`[ok] Zig target: ${report.zigTarget}`);
	if (report.target !== undefined) lines.push(`[ok] C target: ${report.target}`);
	if (report.rustTarget !== undefined)
		lines.push(`[ok] Rust target: ${report.rustTarget}`);
	if (report.probes !== undefined) {
		lines.push(`[${report.probes.c2x ? "ok" : "required"}] C2x compile/link`);
		lines.push(`[${report.probes.cxxLink ? "ok" : "required"}] C++ runtime link`);
		lines.push(`[${report.probes.lto ? "ok" : "optional"}] LTO compile/archive/link`);
		lines.push(`[${report.probes.strip ? "ok" : "optional"}] symbol stripping`);
		lines.push(
			`Probe cache: ${report.cacheHit ? "hit" : "miss"} (${report.fingerprint})`,
		);
	}
	for (const issue of report.issues) {
		if (issue.tool === "strip" || issue.tool === "lto") continue;
		const representedByTool = [
			"zig",
			"cc",
			"cxx",
			"ar",
			"rustup",
			"cargo",
			"rustc",
			"strip",
		].includes(issue.tool);
		if (!representedByTool) {
			lines.push(
				`[${issue.required ? "missing" : "optional"}] ${issue.tool}: ${issue.message}`,
			);
		} else if (!issue.required) lines.push(`warning: ${issue.message}`);
	}
	appendToolchainReportTail(lines, report, platform);
	return lines.join("\n");
}
