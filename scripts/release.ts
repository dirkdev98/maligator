import { execFileSync, spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLATFORM_MODULES } from "../src/platform/catalog.ts";
import { buildProductCli } from "../src/product-builder.ts";
import { resolvePathExecutable } from "../src/toolchain.ts";
import { createReleaseArchive } from "./release-archive.ts";
import { nextAlphaVersion } from "./release-version.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(repositoryRoot, "package.json");
const packageLockPath = path.join(repositoryRoot, "package-lock.json");
const versionSourcePath = path.join(repositoryRoot, "src/version.ts");
const releaseRoot = path.join(repositoryRoot, "dist/release");
const releaseSelectionPath = path.join(releaseRoot, "selection.json");
const releaseStartedAt = performance.now();

export const NPM_WEB_LOGIN_ARGUMENTS = ["login", "--auth-type", "web"] as const;

export type NpmReleaseAuthentication = "web" | "trusted-publishing";

export function expectedReleaseTag(version: string): string {
	return `v${version}`;
}

export function assertReleaseTag(tag: string, version: string): void {
	const expected = expectedReleaseTag(version);
	if (tag !== expected) {
		throw new Error(`release tag must be ${expected}, received ${tag}`);
	}
}

export function parsePublishReleaseArguments(
	args: Array<string>,
	version: string,
): NpmReleaseAuthentication {
	if (args.length < 2 || args[0] !== "--confirm" || args[1] !== version) {
		throw new Error(`publishing requires --confirm ${version}`);
	}
	if (args.length === 2) return "web";
	if (args.length === 3 && args[2] === "--trusted-publishing") {
		return "trusted-publishing";
	}
	throw new Error(`publishing requires --confirm ${version} [--trusted-publishing]`);
}

export function assertGitHubTrustedPublishingEnvironment(
	environment: NodeJS.ProcessEnv,
	version: string,
): void {
	if (
		environment.GITHUB_ACTIONS !== "true" ||
		environment.ACTIONS_ID_TOKEN_REQUEST_URL === undefined ||
		environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined
	) {
		throw new Error(
			"trusted publishing requires GitHub Actions with id-token: write permission",
		);
	}
	const releaseTag =
		environment.GITHUB_REF_TYPE === "tag"
			? environment.GITHUB_REF_NAME
			: environment.GITHUB_EVENT_NAME === "workflow_dispatch" &&
				  environment.GITHUB_REF === "refs/heads/main"
				? environment.MALIGATOR_RELEASE_TAG
				: undefined;
	if (releaseTag === undefined) {
		throw new Error("trusted publishing requires a GitHub release tag or main retry");
	}
	assertReleaseTag(releaseTag, version);
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.round(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function releaseLog(message: string): void {
	console.log(
		`[release +${formatDuration(performance.now() - releaseStartedAt)}] ${message}`,
	);
}

function npmEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		NPM_CONFIG_CACHE: path.join(releaseRoot, "npm-cache"),
	};
}

const targets = [
	{
		rust: "aarch64-apple-darwin",
		platform: "darwin",
		arch: "arm64",
		packageName: "@maligator/cli-darwin-arm64",
	},
	{
		rust: "x86_64-apple-darwin",
		platform: "darwin",
		arch: "x64",
		packageName: "@maligator/cli-darwin-x64",
	},
	{
		rust: "aarch64-unknown-linux-gnu",
		platform: "linux",
		arch: "arm64",
		packageName: "@maligator/cli-linux-arm64",
	},
	{
		rust: "x86_64-unknown-linux-gnu",
		platform: "linux",
		arch: "x64",
		packageName: "@maligator/cli-linux-x64",
	},
];
const defaultTargets = [targets[0]!];

interface PackageJson {
	name: string;
	version: string;
	[key: string]: unknown;
}

function readJson(file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, undefined, "\t")}\n`);
}

function packageVersion(): string {
	const value = readJson(packagePath).version;
	if (typeof value !== "string") throw new Error("package.json#version must be a string");
	return value;
}

function generatedVersionSource(version: string): string {
	return `// Generated from package.json by scripts/release.ts. Do not edit by hand.
export const MALIGATOR_VERSION = ${JSON.stringify(version)};
`;
}

function assertVersionSynchronized(version: string): void {
	const expected = generatedVersionSource(version);
	if (
		!existsSync(versionSourcePath) ||
		readFileSync(versionSourcePath, "utf-8") !== expected
	) {
		throw new Error("src/version.ts is stale; run `npm run version:alpha`");
	}
}

function incrementAlpha(): void {
	const manifest = readJson(packagePath);
	const current = packageVersion();
	const next = nextAlphaVersion(current);
	manifest.version = next;
	writeJson(packagePath, manifest);

	const lock = readJson(packageLockPath);
	lock.version = next;
	const packages = lock.packages;
	if (typeof packages !== "object" || packages === null) {
		throw new Error("package-lock.json#packages is missing");
	}
	const root = (packages as Record<string, unknown>)[""];
	if (typeof root !== "object" || root === null) {
		throw new Error("package-lock.json root package is missing");
	}
	(root as Record<string, unknown>).version = next;
	writeJson(packageLockPath, lock);
	writeFileSync(versionSourcePath, generatedVersionSource(next));
	console.log(`${current} -> ${next}`);
}

function verifyReleaseTag(args: Array<string>): void {
	if (args.length !== 1) {
		throw new Error("usage: npm run release:verify-tag -- <tag>");
	}
	const version = packageVersion();
	assertVersionSynchronized(version);
	assertReleaseTag(args[0]!, version);
	console.log(`Release tag verified: ${args[0]}`);
}

function commonPackageFields(name: string, version: string): PackageJson {
	return {
		name,
		version,
		description: "Ahead-of-time JavaScript compiler and native runtime",
		license: "MIT",
		homepage: "https://github.com/dirkdev98/maligator#readme",
		bugs: { url: "https://github.com/dirkdev98/maligator/issues" },
		repository: {
			type: "git",
			url: "git+https://github.com/dirkdev98/maligator.git",
		},
		keywords: ["javascript", "compiler", "aot", "native", "runtime"],
		publishConfig: { access: "public", tag: "alpha" },
	};
}

const launcherPackageFiles = [
	"bin/maligator.js",
	"index.js",
	"index.d.ts",
	"platform-api.d.ts",
	...PLATFORM_MODULES.map((module) => module.declarationFile).sort(),
	"README.md",
	"LICENSE",
];

export function createLauncherPackageJson(
	version: string,
	platformPackageNames: Array<string>,
): PackageJson {
	return {
		...commonPackageFields("@maligator/cli", version),
		type: "module",
		engines: { node: ">=20.0.0" },
		files: launcherPackageFiles,
		bin: { maligator: "bin/maligator.js" },
		types: "./index.d.ts",
		exports: {
			".": {
				types: "./index.d.ts",
				import: "./index.js",
			},
		},
		optionalDependencies: Object.fromEntries(
			platformPackageNames.map((packageName) => [packageName, version]),
		),
	};
}

function stagePlatformPackage(
	target: (typeof targets)[number],
	version: string,
	artifactDirectory: string,
): string {
	const directory = path.join(releaseRoot, "npm", target.packageName.split("/")[1]!);
	const binaryPath = path.join(directory, "bin/maligator");
	mkdirSync(path.dirname(binaryPath), { recursive: true });
	copyFileSync(path.join(artifactDirectory, "bin/maligator"), binaryPath);
	chmodSync(binaryPath, 0o755);
	copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(directory, "LICENSE"));
	writeJson(path.join(directory, "package.json"), {
		...commonPackageFields(target.packageName, version),
		os: [target.platform],
		cpu: [target.arch],
		files: ["bin/maligator", "LICENSE"],
		bin: { maligator: "bin/maligator" },
	});
	return directory;
}

function stageLauncherPackage(version: string, selected: typeof targets): string {
	const directory = path.join(releaseRoot, "npm/cli");
	mkdirSync(path.join(directory, "bin"), { recursive: true });
	copyFileSync(
		path.join(repositoryRoot, "npm/cli/bin/maligator.js"),
		path.join(directory, "bin/maligator.js"),
	);
	chmodSync(path.join(directory, "bin/maligator.js"), 0o755);
	copyFileSync(
		path.join(repositoryRoot, "npm/cli/README.md"),
		path.join(directory, "README.md"),
	);
	copyFileSync(
		path.join(repositoryRoot, "npm/cli/index.js"),
		path.join(directory, "index.js"),
	);
	copyFileSync(
		path.join(repositoryRoot, "src/public-api.d.ts"),
		path.join(directory, "index.d.ts"),
	);
	for (const module of [...PLATFORM_MODULES, { declarationFile: "platform-api.d.ts" }]) {
		copyFileSync(
			path.join(repositoryRoot, "src", module.declarationFile),
			path.join(directory, module.declarationFile),
		);
	}
	copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(directory, "LICENSE"));
	writeJson(
		path.join(directory, "package.json"),
		createLauncherPackageJson(
			version,
			selected.map((target) => target.packageName),
		),
	);
	return directory;
}

function selectedTargets(args: Array<string>): typeof targets {
	if (args.length === 0) return defaultTargets;
	if (args.length === 1 && args[0] === "--all-targets") return targets;
	if (args.length !== 2 || args[0] !== "--target") {
		throw new Error(
			"usage: npm run release:build -- [--all-targets | --target <rust-triple>]",
		);
	}
	const selected = targets.find((target) => target.rust === args[1]);
	if (selected === undefined) throw new Error(`unsupported release target: ${args[1]}`);
	return [selected];
}

export function selectReleaseTargetTriples(args: Array<string>): Array<string> {
	return selectedTargets(args).map((target) => target.rust);
}

function buildRelease(args: Array<string>): void {
	const version = packageVersion();
	assertVersionSynchronized(version);
	const selected = selectedTargets(args);
	rmSync(releaseRoot, { recursive: true, force: true });
	mkdirSync(path.join(releaseRoot, "artifacts"), { recursive: true });
	releaseLog(
		`building ${version} for ${selected.length} target${selected.length === 1 ? "" : "s"}: ${selected.map((target) => target.rust).join(", ")}`,
	);
	for (const [index, target] of selected.entries()) {
		const targetStartedAt = performance.now();
		const prefix = `[${index + 1}/${selected.length} ${target.rust}]`;
		releaseLog(`${prefix} build started`);
		const rootName = `maligator-v${version}-${target.rust}`;
		const artifactDirectory = path.join(releaseRoot, "artifacts", rootName);
		buildProductCli({
			repositoryRoot,
			outDir: path.join(releaseRoot, "build", target.rust),
			name: "maligator",
			target: target.rust,
			production: true,
			artifactDirectory,
			onProgress: (message) => releaseLog(`${prefix} ${message}`),
		});
		releaseLog(`${prefix} creating deterministic archive`);
		createReleaseArchive(
			artifactDirectory,
			path.join(releaseRoot, "artifacts", `${rootName}.tar.gz`),
			rootName,
		);
		releaseLog(`${prefix} staging ${target.packageName}`);
		stagePlatformPackage(target, version, artifactDirectory);
		releaseLog(
			`${prefix} complete in ${formatDuration(performance.now() - targetStartedAt)}`,
		);
	}
	stageLauncherPackage(version, selected);
	writeJson(releaseSelectionPath, {
		schema: 1,
		version,
		targets: selected.map((target) => target.rust),
	});
	releaseLog(`release artifacts ready: ${releaseRoot}`);
}

function smokeRelease(): void {
	releaseLog("preparing host release smoke");
	const target = targets.find(
		(candidate) =>
			candidate.platform === process.platform && candidate.arch === process.arch,
	);
	if (target === undefined) {
		throw new Error(
			`release smoke is unsupported on ${process.platform}-${process.arch}`,
		);
	}

	const version = packageVersion();
	assertVersionSynchronized(version);
	const binary = path.join(
		releaseRoot,
		"artifacts",
		`maligator-v${version}-${target.rust}`,
		"bin/maligator",
	);
	if (!existsSync(binary)) {
		throw new Error(
			`host release binary is missing; run \`npm run release:build -- --target ${target.rust}\``,
		);
	}
	const smokeRoot = mkdtempSync(path.join(os.tmpdir(), "maligator-release-smoke-"));
	const project = path.join(smokeRoot, "project");
	const tools = path.join(smokeRoot, "tools");
	mkdirSync(project);
	mkdirSync(tools);

	const originalPath = process.env.PATH ?? "";
	const rustup = resolvePathExecutable("rustup", originalPath);
	const rustDirectory = path.join(repositoryRoot, "runtime/rust");
	const requiredTools: Array<[string, string]> = [
		["cc", process.env.CC?.trim() || "cc"],
		["c++", process.env.CXX?.trim() || "c++"],
		["ar", "ar"],
		["rustup", rustup],
		[
			"cargo",
			execFileSync(rustup, ["which", "cargo"], {
				cwd: rustDirectory,
				encoding: "utf-8",
			}).trim(),
		],
		[
			"rustc",
			execFileSync(rustup, ["which", "rustc"], {
				cwd: rustDirectory,
				encoding: "utf-8",
			}).trim(),
		],
	];
	// Linux compiler drivers resolve these through PATH. Keep the release smoke
	// isolated while still providing the assembler and linker needed by cc/c++.
	if (process.platform === "linux") {
		requiredTools.push(["as", "as"], ["ld", "ld"]);
	}
	for (const [name, executable] of requiredTools) {
		const source = executable.includes(path.sep)
			? executable
			: resolvePathExecutable(executable, originalPath);
		symlinkSync(source, path.join(tools, name));
	}
	for (const optional of ["strip", "make", "ninja", "ranlib"]) {
		try {
			symlinkSync(
				resolvePathExecutable(optional, originalPath),
				path.join(tools, optional),
			);
		} catch {
			// Optional accelerators must not prevent the release smoke from running.
		}
	}

	const environment = {
		...process.env,
		PATH: tools,
		CC: path.join(tools, "cc"),
		CXX: path.join(tools, "c++"),
	};
	const invoke = (args: Array<string>): string =>
		execFileSync(binary, args, {
			cwd: project,
			env: environment,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});

	try {
		releaseLog("checking CLI metadata and isolated toolchain");
		if (!invoke(["--help"]).includes("maligator <command>")) {
			throw new Error("host release binary did not print CLI help");
		}
		const reportedVersion = invoke(["--version"]).trim();
		if (reportedVersion !== version) {
			throw new Error(
				`host release binary reported ${reportedVersion}, expected ${version}`,
			);
		}
		if (!invoke(["doctor"]).includes("Toolchain is ready.")) {
			throw new Error("host release binary did not accept the isolated toolchain");
		}
		invoke(["init"]);
		writeFileSync(
			path.join(project, "maligator.build.ts"),
			`export default { entry: "main.ts", outputName: "release-smoke" };\n`,
		);
		writeFileSync(path.join(project, "main.ts"), `console.log("release smoke app");\n`);
		releaseLog("building and executing isolated smoke application");
		const artifact = path.join(smokeRoot, "application");
		invoke(["build", "--production", "--artifact", artifact, "--verbose"]);
		const applicationOutput = execFileSync(path.join(artifact, "bin/release-smoke"), [], {
			cwd: smokeRoot,
			env: { PATH: tools },
			encoding: "utf-8",
		});
		if (applicationOutput.trim() !== "release smoke app") {
			throw new Error(`release-built application reported ${applicationOutput.trim()}`);
		}
	} finally {
		rmSync(smokeRoot, { recursive: true, force: true });
	}
	releaseLog(`host release smoke passed: ${target.rust}`);
	console.log(`Host release smoke passed: ${target.rust}`);
}

interface PackedPackage {
	name: string;
	filename: string;
	files: Array<{ path: string }>;
}

export interface ReleasePackageEntry {
	name: string;
	file: string;
	sha256: string;
}

export interface ReleaseManifest {
	schema: 2;
	version: string;
	targets: Array<string>;
	packages: Array<ReleasePackageEntry>;
}

function packDirectory(
	directory: string,
	destination: string,
	expectedFiles: Array<string>,
): string {
	const output = execFileSync(
		"npm",
		["pack", "--json", "--pack-destination", destination],
		{ cwd: directory, encoding: "utf-8", env: npmEnvironment() },
	);
	const result = JSON.parse(output) as Array<PackedPackage>;
	const packed = result[0];
	if (packed === undefined || packed.filename === undefined) {
		throw new Error(`npm pack returned no filename for ${directory}`);
	}
	const filename = packed.filename;
	const actualFiles = packed.files.map((file) => file.path).sort();
	const expected = [...expectedFiles, "package.json"].sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) {
		throw new Error(
			`unexpected npm pack contents for ${packed.name}: ${actualFiles.join(", ")}`,
		);
	}
	return path.join(destination, filename);
}

function smokePackedLauncher(
	target: (typeof targets)[number],
	platformTarball: string,
	launcherTarball: string,
	version: string,
): void {
	if (target.platform !== process.platform || target.arch !== process.arch) return;
	const smokeRoot = path.join(releaseRoot, "pack-smoke");
	mkdirSync(smokeRoot, { recursive: true });
	const project = mkdtempSync(path.join(smokeRoot, "project-"));
	try {
		writeJson(path.join(project, "package.json"), {
			name: "maligator-release-smoke",
			version: "0.0.0",
			private: true,
		});
		const installArguments = [
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--omit=optional",
			"--offline",
		];
		execFileSync("npm", [...installArguments, launcherTarball, platformTarball], {
			cwd: project,
			stdio: "pipe",
			env: npmEnvironment(),
		});
		const output = execFileSync(
			path.join(project, "node_modules/.bin/maligator"),
			["--version"],
			{
				cwd: project,
				encoding: "utf-8",
			},
		);
		if (output.trim() !== version) {
			throw new Error(`packed launcher reported ${output.trim()}, expected ${version}`);
		}
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
}

function packRelease(args: Array<string>): void {
	const version = packageVersion();
	assertVersionSynchronized(version);
	const selected = selectedTargets(args);
	const selection = readJson(releaseSelectionPath);
	const selectedNames = selected.map((target) => target.rust);
	if (
		selection.version !== version ||
		JSON.stringify(selection.targets) !== JSON.stringify(selectedNames)
	) {
		throw new Error(
			"packed targets must match the preceding release build; rebuild with the same target options",
		);
	}
	const npmRoot = path.join(releaseRoot, "npm");
	const packs = path.join(releaseRoot, "packs");
	rmSync(packs, { recursive: true, force: true });
	mkdirSync(packs, { recursive: true });
	const packedPackages: Array<{ name: string; file: string; sha256: string }> = [];
	const platformTarballs = new Map<string, string>();
	releaseLog(
		`packing ${selected.length + 1} npm package${selected.length === 0 ? "" : "s"}`,
	);
	for (const [index, target] of selected.entries()) {
		releaseLog(`[${index + 1}/${selected.length + 1}] packing ${target.packageName}`);
		const directory = path.join(npmRoot, target.packageName.split("/")[1]!);
		if (!existsSync(directory)) {
			throw new Error("build the complete target matrix before packing");
		}
		const packed = packDirectory(directory, packs, ["LICENSE", "bin/maligator"]);
		platformTarballs.set(target.rust, packed);
		packedPackages.push({
			name: target.packageName,
			file: path.basename(packed),
			sha256: hash("sha256", readFileSync(packed), "hex"),
		});
	}
	const launcher = path.join(npmRoot, "cli");
	if (!existsSync(launcher)) throw new Error("launcher package is missing");
	releaseLog(`[${selected.length + 1}/${selected.length + 1}] packing @maligator/cli`);
	const packedLauncher = packDirectory(launcher, packs, launcherPackageFiles);
	packedPackages.push({
		name: "@maligator/cli",
		file: path.basename(packedLauncher),
		sha256: hash("sha256", readFileSync(packedLauncher), "hex"),
	});
	for (const target of selected) {
		if (target.platform === process.platform && target.arch === process.arch) {
			releaseLog(`smoke-testing packed launcher for ${target.rust}`);
		}
		smokePackedLauncher(
			target,
			platformTarballs.get(target.rust)!,
			packedLauncher,
			version,
		);
	}
	writeJson(path.join(packs, "packages.json"), {
		schema: 2,
		version,
		targets: selectedNames,
		packages: packedPackages,
	});
	releaseLog(`npm tarballs ready: ${packs}`);
}

export function parseReleaseManifest(
	manifest: Record<string, unknown>,
	version: string,
): ReleaseManifest {
	if (
		manifest.schema !== 2 ||
		manifest.version !== version ||
		!Array.isArray(manifest.targets) ||
		!manifest.targets.every((target) => typeof target === "string") ||
		!Array.isArray(manifest.packages)
	) {
		throw new Error("packed package manifest does not match the release version");
	}
	const packages = manifest.packages.map((value) => {
		if (typeof value !== "object" || value === null) {
			throw new Error("invalid packed package manifest");
		}
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.name !== "string" ||
			typeof entry.file !== "string" ||
			entry.file !== path.basename(entry.file) ||
			!entry.file.endsWith(".tgz") ||
			typeof entry.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.sha256)
		) {
			throw new Error("invalid packed package manifest");
		}
		return entry as unknown as ReleasePackageEntry;
	});
	return {
		schema: 2,
		version,
		targets: manifest.targets,
		packages,
	};
}

function readReleaseManifest(version: string): ReleaseManifest {
	return parseReleaseManifest(
		readJson(path.join(releaseRoot, "packs/packages.json")),
		version,
	);
}

function verifiedTarball(entry: ReleasePackageEntry): Buffer {
	const tarball = path.join(releaseRoot, "packs", entry.file);
	const bytes = readFileSync(tarball);
	if (hash("sha256", bytes, "hex") !== entry.sha256) {
		throw new Error(`packed tarball changed: ${entry.file}`);
	}
	return bytes;
}

function assertCleanWorktree(): void {
	const status = execFileSync("git", ["status", "--porcelain"], {
		cwd: repositoryRoot,
		encoding: "utf-8",
	});
	if (status.trim() !== "") throw new Error("refusing to release from a dirty worktree");
}

function assertGitHubReleaseImmutability(): void {
	const settings = JSON.parse(
		execFileSync(
			"gh",
			[
				"api",
				"-H",
				"X-GitHub-Api-Version: 2026-03-10",
				"repos/dirkdev98/maligator/immutable-releases",
			],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		),
	) as { enabled?: boolean };
	if (settings.enabled !== true) {
		throw new Error("enable GitHub immutable releases before uploading npm assets");
	}
}

function createGitHubRelease(args: Array<string>): void {
	const version = packageVersion();
	if (args.length !== 2 || args[0] !== "--confirm" || args[1] !== version) {
		throw new Error(`creating a GitHub release requires --confirm ${version}`);
	}
	assertVersionSynchronized(version);
	assertCleanWorktree();
	const head = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repositoryRoot,
		encoding: "utf-8",
	}).trim();
	const remoteMain = execFileSync("git", ["rev-parse", "origin/main"], {
		cwd: repositoryRoot,
		encoding: "utf-8",
	}).trim();
	if (head !== remoteMain) {
		throw new Error("GitHub releases require HEAD to equal the pushed origin/main");
	}
	assertGitHubReleaseImmutability();

	const manifest = readReleaseManifest(version);
	for (const entry of manifest.packages) verifiedTarball(entry);
	const tag = expectedReleaseTag(version);
	const assets = [
		path.join(releaseRoot, "packs/packages.json"),
		...manifest.packages.map((entry) => path.join(releaseRoot, "packs", entry.file)),
	];
	releaseLog(`creating draft GitHub prerelease ${tag} with ${assets.length} assets`);
	execFileSync(
		"gh",
		[
			"release",
			"create",
			tag,
			...assets,
			"--draft",
			"--prerelease",
			"--latest=false",
			"--target",
			head,
			"--title",
			`Maligator ${tag}`,
			"--notes",
			"Prepared npm alpha release assets.",
		],
		{ cwd: repositoryRoot, stdio: "inherit" },
	);
	const release = JSON.parse(
		execFileSync(
			"gh",
			["release", "view", tag, "--json", "assets,isDraft,tagName,targetCommitish"],
			{ cwd: repositoryRoot, encoding: "utf-8" },
		),
	) as {
		assets?: Array<{ name?: string }>;
		isDraft?: boolean;
		tagName?: string;
		targetCommitish?: string;
	};
	const expectedAssets = assets.map((asset) => path.basename(asset)).sort();
	const actualAssets = (release.assets ?? [])
		.map((asset) => asset.name)
		.filter((name): name is string => name !== undefined)
		.sort();
	if (
		release.isDraft !== true ||
		release.tagName !== tag ||
		release.targetCommitish !== head ||
		JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)
	) {
		throw new Error(`draft GitHub release ${tag} did not retain the expected assets`);
	}
	releaseLog(`publishing GitHub prerelease ${tag}; this triggers npm publication`);
	execFileSync("gh", ["release", "edit", tag, "--draft=false"], {
		cwd: repositoryRoot,
		stdio: "inherit",
	});
	const published = JSON.parse(
		execFileSync("gh", ["release", "view", tag, "--json", "isImmutable,url"], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		}),
	) as { isImmutable?: boolean; url?: string };
	if (published.isImmutable !== true) {
		throw new Error(`published GitHub release ${tag} is not immutable`);
	}
	releaseLog(`immutable GitHub release ready: ${published.url ?? tag}`);
}

export function preparedTarballIntegrity(bytes: Uint8Array): string {
	return `sha512-${hash("sha512", bytes, "base64")}`;
}

export function matchingPublishedIntegrity(
	packageName: string,
	publishedIntegrity: string | undefined,
	tarball: Uint8Array,
): boolean {
	if (publishedIntegrity === undefined) return false;
	const preparedIntegrity = preparedTarballIntegrity(tarball);
	if (publishedIntegrity !== preparedIntegrity) {
		throw new Error(
			`${packageName} is already published with different contents; refusing to continue`,
		);
	}
	return true;
}

function publishedPackageIntegrity(
	packageName: string,
	version: string,
): string | undefined {
	const view = spawnSync(
		"npm",
		["view", `${packageName}@${version}`, "dist.integrity", "--json"],
		{
			cwd: repositoryRoot,
			encoding: "utf-8",
			env: npmEnvironment(),
		},
	);
	if (view.error !== undefined) throw view.error;
	if (view.status !== 0) {
		const output = `${view.stdout ?? ""}\n${view.stderr ?? ""}`;
		if (output.includes("E404") || output.includes("No match found for version")) {
			return undefined;
		}
		throw new Error(
			view.signal === null
				? `npm view exited with status ${view.status}: ${output.trim()}`
				: `npm view terminated by ${view.signal}`,
		);
	}
	const integrity: unknown = JSON.parse(view.stdout);
	if (typeof integrity !== "string") {
		throw new Error(`npm returned invalid integrity metadata for ${packageName}`);
	}
	return integrity;
}

function publishRelease(args: Array<string>): void {
	const version = packageVersion();
	const authentication = parsePublishReleaseArguments(args, version);
	assertVersionSynchronized(version);
	assertCleanWorktree();
	const manifest = readReleaseManifest(version);
	const selected = manifest.targets.map((rust) => {
		const target = targets.find((candidate) => candidate.rust === rust);
		if (target === undefined) throw new Error(`unsupported release target: ${rust}`);
		return target;
	});
	const expectedNames = [
		...selected.map((target) => target.packageName),
		"@maligator/cli",
	];
	const actualNames = manifest.packages.map((entry) => entry.name);
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		throw new Error("refusing to publish an incomplete or unordered package set");
	}
	if (authentication === "trusted-publishing") {
		assertGitHubTrustedPublishingEnvironment(process.env, version);
		releaseLog("authenticating to npm with GitHub Actions trusted publishing");
	} else {
		releaseLog("authenticating to npm with web login");
		const login = spawnSync("npm", [...NPM_WEB_LOGIN_ARGUMENTS], {
			cwd: repositoryRoot,
			stdio: ["inherit", "inherit", "inherit"],
			env: npmEnvironment(),
		});
		if (login.error !== undefined) throw login.error;
		if (login.status !== 0) {
			throw new Error(
				login.signal === null
					? `npm web login exited with status ${login.status}`
					: `npm web login terminated by ${login.signal}`,
			);
		}
	}
	releaseLog(`publishing ${expectedNames.length} packages under the alpha tag`);
	for (const [index, entry] of manifest.packages.entries()) {
		const tarball = path.join(releaseRoot, "packs", entry.file);
		const tarballBytes = verifiedTarball(entry);
		const packageName = expectedNames[index]!;
		if (
			matchingPublishedIntegrity(
				packageName,
				publishedPackageIntegrity(packageName, version),
				tarballBytes,
			)
		) {
			releaseLog(
				`[${index + 1}/${expectedNames.length}] ${packageName} already published; integrity matches`,
			);
			continue;
		}
		releaseLog(`[${index + 1}/${expectedNames.length}] publishing ${packageName}`);
		const publish = spawnSync(
			"npm",
			["publish", tarball, "--access", "public", "--tag", "alpha"],
			{
				cwd: repositoryRoot,
				// npm owns the complete exchange: either the interactive OTP prompt
				// or the GitHub Actions OIDC token exchange.
				stdio: ["inherit", "inherit", "inherit"],
				env: npmEnvironment(),
			},
		);
		if (publish.error !== undefined) throw publish.error;
		if (publish.status !== 0) {
			throw new Error(
				publish.signal === null
					? `npm publish exited with status ${publish.status}`
					: `npm publish terminated by ${publish.signal}`,
			);
		}
	}
	releaseLog(`published ${version} under the alpha tag`);
}

function usage(): never {
	throw new Error(
		"usage: node scripts/release.ts <version-alpha|verify-tag|build|pack|create-github|publish|smoke> [options]",
	);
}

if (import.meta.main) {
	const command = process.argv[2];
	if (command === "version-alpha") incrementAlpha();
	else if (command === "verify-tag") verifyReleaseTag(process.argv.slice(3));
	else if (command === "build") buildRelease(process.argv.slice(3));
	else if (command === "pack") packRelease(process.argv.slice(3));
	else if (command === "create-github") createGitHubRelease(process.argv.slice(3));
	else if (command === "publish") publishRelease(process.argv.slice(3));
	else if (command === "smoke") smokeRelease();
	else usage();
}
