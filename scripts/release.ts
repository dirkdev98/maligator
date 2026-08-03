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
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { buildProductCli } from "../src/product-builder.ts";
import { createReleaseArchive } from "./release-archive.ts";
import { nextAlphaVersion } from "./release-version.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(repositoryRoot, "package.json");
const packageLockPath = path.join(repositoryRoot, "package-lock.json");
const versionSourcePath = path.join(repositoryRoot, "src/version.ts");
const releaseRoot = path.join(repositoryRoot, "dist/release");
const releaseSelectionPath = path.join(releaseRoot, "selection.json");
const releaseStartedAt = performance.now();

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
	copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(directory, "LICENSE"));
	writeJson(path.join(directory, "package.json"), {
		...commonPackageFields("@maligator/cli", version),
		type: "module",
		engines: { node: ">=20.0.0" },
		files: ["bin/maligator.js", "README.md", "LICENSE"],
		bin: { maligator: "bin/maligator.js" },
		optionalDependencies: Object.fromEntries(
			selected.map((target) => [target.packageName, version]),
		),
	});
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
	const output = execFileSync(binary, ["--version"], {
		cwd: releaseRoot,
		encoding: "utf-8",
	});
	if (output.trim() !== version) {
		throw new Error(`host release binary reported ${output.trim()}, expected ${version}`);
	}
	console.log(`Host release smoke passed: ${target.rust}`);
}

interface PackedPackage {
	name: string;
	filename: string;
	files: Array<{ path: string }>;
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
	const packedLauncher = packDirectory(launcher, packs, [
		"LICENSE",
		"README.md",
		"bin/maligator.js",
	]);
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

function publishRelease(args: Array<string>): void {
	const version = packageVersion();
	if (args.length !== 2 || args[0] !== "--confirm" || args[1] !== version) {
		throw new Error(`publishing requires --confirm ${version}`);
	}
	assertVersionSynchronized(version);
	const status = execFileSync("git", ["status", "--porcelain"], {
		cwd: repositoryRoot,
		encoding: "utf-8",
	});
	if (status.trim() !== "") throw new Error("refusing to publish from a dirty worktree");
	const manifest = readJson(path.join(releaseRoot, "packs/packages.json"));
	if (
		manifest.schema !== 2 ||
		manifest.version !== version ||
		!Array.isArray(manifest.targets) ||
		!Array.isArray(manifest.packages)
	) {
		throw new Error("packed package manifest does not match the release version");
	}
	const selected = manifest.targets.map((rust) => {
		if (typeof rust !== "string") throw new Error("invalid release target manifest");
		const target = targets.find((candidate) => candidate.rust === rust);
		if (target === undefined) throw new Error(`unsupported release target: ${rust}`);
		return target;
	});
	const expectedNames = [
		...selected.map((target) => target.packageName),
		"@maligator/cli",
	];
	const actualNames = manifest.packages.map((entry) =>
		typeof entry === "object" && entry !== null
			? (entry as Record<string, unknown>).name
			: undefined,
	);
	if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
		throw new Error("refusing to publish an incomplete or unordered package set");
	}
	releaseLog(`publishing ${expectedNames.length} packages under the alpha tag`);
	for (const [index, entry] of (
		manifest.packages as Array<Record<string, unknown>>
	).entries()) {
		if (typeof entry.file !== "string")
			throw new Error("invalid packed package manifest");
		const tarball = path.join(releaseRoot, "packs", entry.file);
		const digest = hash("sha256", readFileSync(tarball), "hex");
		if (digest !== entry.sha256) throw new Error(`packed tarball changed: ${entry.file}`);
		releaseLog(
			`[${index + 1}/${expectedNames.length}] publishing ${expectedNames[index]}`,
		);
		const publish = spawnSync(
			"npm",
			["publish", tarball, "--access", "public", "--tag", "alpha"],
			{
				cwd: repositoryRoot,
				// npm owns the complete interactive exchange. In particular, stdin
				// remains attached to the terminal so its native OTP prompt works.
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
		"usage: node scripts/release.ts <version-alpha|build|pack|publish|smoke> [options]",
	);
}

if (import.meta.main) {
	const command = process.argv[2];
	if (command === "version-alpha") incrementAlpha();
	else if (command === "build") buildRelease(process.argv.slice(3));
	else if (command === "pack") packRelease(process.argv.slice(3));
	else if (command === "publish") publishRelease(process.argv.slice(3));
	else if (command === "smoke") smokeRelease();
	else usage();
}
