import { hash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";

export interface BuildArtifactOptions {
	binaryPath: string;
	directory: string;
	executableName?: string;
	licensePath?: string;
	version: string;
	target: string;
	production: boolean;
	additionalFiles?: Array<{ sourcePath: string; path: string }>;
}

export interface BuildArtifactManifest {
	schema: 1;
	name: string;
	version: string;
	target: string;
	production: boolean;
	files: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface BuildArtifactResult {
	directory: string;
	binaryPath: string;
	manifestPath: string;
	checksumsPath: string;
	manifest: BuildArtifactManifest;
}

/**
 * Materialize the build-owned, unpacked artifact layout. Release automation may
 * archive this directory, but it must not reinterpret or reconstruct its contents.
 */
export function createBuildArtifact(options: BuildArtifactOptions): BuildArtifactResult {
	const directory = path.resolve(options.directory);
	if (existsSync(directory) && readdirSync(directory).length > 0) {
		throw new Error(`artifact directory is not empty: ${directory}`);
	}

	const executableName = options.executableName ?? path.basename(options.binaryPath);
	if (
		executableName.length === 0 ||
		executableName === "." ||
		executableName === ".." ||
		executableName.includes("/") ||
		executableName.includes("\\") ||
		executableName.includes("\0")
	) {
		throw new Error("artifact executable name must be a safe filename");
	}

	const relativeBinaryPath = `bin/${executableName}`;
	const binaryPath = path.join(directory, "bin", executableName);
	mkdirSync(path.dirname(binaryPath), { recursive: true });
	copyFileSync(options.binaryPath, binaryPath);
	const bytes = readFileSync(binaryPath);
	const digest = hash("sha256", bytes, "hex");
	const manifest: BuildArtifactManifest = {
		schema: 1,
		name: executableName,
		version: options.version,
		target: options.target,
		production: options.production,
		files: [{ path: relativeBinaryPath, sha256: digest, bytes: bytes.length }],
	};
	if (options.licensePath !== undefined) {
		const licensePath = path.join(directory, "LICENSE");
		copyFileSync(options.licensePath, licensePath);
		const license = readFileSync(licensePath);
		manifest.files.push({
			path: "LICENSE",
			sha256: hash("sha256", license, "hex"),
			bytes: license.length,
		});
	}
	for (const additional of options.additionalFiles ?? []) {
		const relativePath = additional.path.replaceAll("\\", "/");
		if (
			path.isAbsolute(additional.path) ||
			relativePath === "" ||
			relativePath.split("/").some((part) => part === "" || part === "." || part === "..") ||
			manifest.files.some((file) => file.path === relativePath)
		) {
			throw new Error(`artifact file path must be unique and relative: ${additional.path}`);
		}
		const destination = path.join(directory, relativePath);
		mkdirSync(path.dirname(destination), { recursive: true });
		copyFileSync(additional.sourcePath, destination);
		const contents = readFileSync(destination);
		manifest.files.push({
			path: relativePath,
			sha256: hash("sha256", contents, "hex"),
			bytes: contents.length,
		});
	}
	const manifestPath = path.join(directory, "artifact.json");
	const checksumsPath = path.join(directory, "SHA256SUMS");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
	writeFileSync(
		checksumsPath,
		manifest.files.map((file) => `${file.sha256}  ${file.path}\n`).join(""),
	);
	return { directory, binaryPath, manifestPath, checksumsPath, manifest };
}
