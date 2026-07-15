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

const CACHE_SCHEMA = 2;
const C2X_FLAGS = ["-std=c2x"];
const LTO_FLAGS = ["-flto"];

export interface ToolExecutable {
	path: string;
	version: string;
}

export interface ToolchainTools {
	cc: ToolExecutable;
	cxx?: ToolExecutable;
	ar: ToolExecutable;
	rustup: ToolExecutable;
	cargo: ToolExecutable;
	rustc: ToolExecutable;
	strip?: ToolExecutable;
}

export interface ToolchainProbes {
	c2x: boolean;
	lto: boolean;
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
	probes: ToolchainProbes;
	fingerprint: string;
	cacheHit: boolean;
}

export interface ToolchainReport {
	tools: Partial<ToolchainTools>;
	target?: string;
	rustTarget?: string;
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
		this.name = "ToolchainError";
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
	const selected = run(rustup.path, ["which", name], { cwd: rustDir, env });
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
		lto: LTO_FLAGS,
		strip: platform === "darwin" ? [["-x"], ["-S"]] : [["--strip-all"], ["-s"]],
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
	return run(cc.path, args, { cwd, env }).ok;
}

function probeCapabilities(
	tools: ToolchainTools,
	probeDir: string,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	needsCxx: boolean,
): ToolchainProbes {
	writeFileSync(
		path.join(probeDir, "main.c"),
		"#if !defined(__STDC_VERSION__) || __STDC_VERSION__ < 202000L\n#error C2x required\n#endif\nint main(void) { return 0; }\n",
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
	const ltoCompile =
		compile(
			tools.cc,
			[...C2X_FLAGS, ...LTO_FLAGS, "-c", "lto-lib.c", "-o", "lto-lib.o"],
			probeDir,
			env,
		) &&
		compile(
			tools.cc,
			[...C2X_FLAGS, ...LTO_FLAGS, "-c", "lto-main.c", "-o", "lto-main.o"],
			probeDir,
			env,
		);
	const ltoArchive =
		ltoCompile &&
		run(tools.ar.path, ["rcs", "liblto-probe.a", "lto-lib.o"], { cwd: probeDir, env }).ok;
	const lto =
		ltoArchive &&
		compile(
			tools.cc,
			[...C2X_FLAGS, ...LTO_FLAGS, "lto-main.o", "liblto-probe.a", "-o", "lto-probe"],
			probeDir,
			env,
		);

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
		const candidates =
			platform === "darwin" ? [["-x"], ["-S"]] : [["--strip-all"], ["-s"]];
		for (const args of candidates) {
			copyFileSync(path.join(probeDir, "c2x-probe"), path.join(probeDir, "strip-probe"));
			if (run(tools.strip.path, [...args, "strip-probe"], { cwd: probeDir, env }).ok) {
				strip = true;
				stripArgs = args;
				break;
			}
		}
	}

	return { c2x, lto, strip, cxxLink, stripArgs, cxxLinkArgs };
}

function rustHostTarget(
	rustc: ToolExecutable,
	rustDir: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const result = run(rustc.path, ["-vV"], { cwd: rustDir, env });
	if (!result.ok) return undefined;
	return /^host:\s*(.+)$/m.exec(result.stdout)?.[1];
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
	const env = options.env ?? process.env;
	const searchPath = env.PATH ?? "";
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const needsCxx = options.needsCxx ?? true;
	const issues: Array<ToolchainIssue> = [];
	const tools: Partial<ToolchainTools> = {};

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

	const strip = inspectExecutable("strip", searchPath, rootDir, env, ["--version"], true);
	if (strip === undefined)
		addMissingIssue(issues, "strip", "symbol stripping is unavailable", false);
	else tools.strip = strip;

	const report: ToolchainReport = { tools, cacheHit: false, issues };
	if (
		tools.cc === undefined ||
		tools.ar === undefined ||
		tools.rustup === undefined ||
		tools.cargo === undefined ||
		tools.rustc === undefined ||
		(needsCxx && tools.cxx === undefined)
	) {
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
	};
	const ccTargetResult = run(completeTools.cc.path, ["-dumpmachine"], {
		cwd: rootDir,
		env,
	});
	const target =
		ccTargetResult.ok && ccTargetResult.stdout.trim()
			? ccTargetResult.stdout.trim()
			: `${arch}-${platform}`;
	const rustTarget = rustHostTarget(completeTools.rustc, rustDir, env) ?? "unknown";
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
		throw new ToolchainError(report, options.platform ?? process.platform);
	}
	return report.toolchain;
}

function installationSuggestions(
	report: ToolchainReport,
	platform: NodeJS.Platform,
): Array<string> {
	const missing = new Set(
		report.issues.filter((issue) => issue.required).map((issue) => issue.tool),
	);
	const suggestions: Array<string> = [];
	if (["cc", "cxx", "ar"].some((tool) => missing.has(tool))) {
		if (platform === "darwin")
			suggestions.push("Install Apple build tools: xcode-select --install");
		else if (platform === "linux") {
			suggestions.push("Debian/Ubuntu: sudo apt install build-essential");
			suggestions.push("Fedora/RHEL: sudo dnf install gcc gcc-c++ binutils");
		}
	}
	if (["rustup", "cargo", "rustc"].some((tool) => missing.has(tool))) {
		suggestions.push(
			"Install Rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
		);
		suggestions.push(
			"Then install the pinned toolchain: (cd runtime/rust && rustup show)",
		);
	}
	return suggestions;
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
		const suggestions = installationSuggestions(report, platform);
		if (suggestions.length > 0)
			lines.push("", "Suggested fixes:", ...suggestions.map((item) => `  ${item}`));
		lines.push(
			"",
			report.toolchain === undefined ? "Toolchain is not ready." : "Toolchain is ready.",
		);
		return lines.join("\n");
	}
	for (const name of ["cc", "cxx", "ar", "rustup", "cargo", "rustc", "strip"] as const) {
		const tool = report.tools[name];
		if (tool !== undefined) lines.push(`[ok] ${name}: ${tool.path} (${tool.version})`);
		else {
			const issue = report.issues.find((candidate) => candidate.tool === name);
			if (issue !== undefined)
				lines.push(
					`[${issue.required ? "missing" : "optional"}] ${name}: ${issue.message}`,
				);
		}
	}
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
		if (!issue.required) lines.push(`warning: ${issue.message}`);
	}
	const suggestions = installationSuggestions(report, platform);
	if (suggestions.length > 0)
		lines.push("", "Suggested fixes:", ...suggestions.map((item) => `  ${item}`));
	lines.push(
		"",
		report.toolchain === undefined ? "Toolchain is not ready." : "Toolchain is ready.",
	);
	return lines.join("\n");
}
