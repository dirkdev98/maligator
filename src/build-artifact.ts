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
	const manifestPath = path.join(directory, "artifact.json");
	const checksumsPath = path.join(directory, "SHA256SUMS");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
	writeFileSync(
		checksumsPath,
		manifest.files.map((file) => `${file.sha256}  ${file.path}\n`).join(""),
	);
	return { directory, binaryPath, manifestPath, checksumsPath, manifest };
}
