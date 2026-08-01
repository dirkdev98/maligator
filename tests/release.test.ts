import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createReleaseArchive, deterministicTar } from "../scripts/release-archive.ts";
import { nextAlphaVersion } from "../scripts/release-version.ts";
import { selectReleaseTargetTriples } from "../scripts/release.ts";
import { createBuildArtifact } from "../src/build-artifact.ts";
import { MALIGATOR_VERSION } from "../src/version.ts";

function temporaryDirectory(): string {
	return mkdtempSync(path.join(os.tmpdir(), "maligator-release-"));
}

describe("build artifacts", () => {
	it("creates a stable deployable layout with exact metadata and checksums", () => {
		const root = temporaryDirectory();
		const source = path.join(root, "source");
		const license = path.join(root, "LICENSE");
		const directory = path.join(root, "artifact");
		writeFileSync(source, "native-binary");
		writeFileSync(license, "MIT");
		chmodSync(source, 0o755);

		const result = createBuildArtifact({
			binaryPath: source,
			directory,
			executableName: "maligator",
			licensePath: license,
			version: MALIGATOR_VERSION,
			target: "aarch64-apple-darwin",
			production: true,
		});

		expect(readFileSync(result.binaryPath, "utf-8")).toBe("native-binary");
		expect(result.manifest).toEqual({
			schema: 1,
			name: "maligator",
			version: MALIGATOR_VERSION,
			target: "aarch64-apple-darwin",
			production: true,
			files: [
				{
					path: "bin/maligator",
					sha256: "9ec4c62cbabe2558224228ab3254a4e20e24cdf57a2cf3be50f37111723595e5",
					bytes: 13,
				},
				{
					path: "LICENSE",
					sha256: "e5dcffe836b6ec8a58e492419b550e65fb8cbdc308503979e5dacb33ac7ea3b7",
					bytes: 3,
				},
			],
		});
		expect(readFileSync(path.join(directory, "LICENSE"), "utf-8")).toBe("MIT");
		expect(readFileSync(result.checksumsPath, "utf-8")).toBe(
			`${result.manifest.files[0]!.sha256}  bin/maligator\n` +
				`${result.manifest.files[1]!.sha256}  LICENSE\n`,
		);
		expect(() =>
			createBuildArtifact({
				binaryPath: source,
				directory,
				version: MALIGATOR_VERSION,
				target: "aarch64-apple-darwin",
				production: true,
			}),
		).toThrow("artifact directory is not empty");
	});

	it("writes byte-identical tar and gzip output", () => {
		const firstTar = deterministicTar([
			{ name: "root/b", mode: 0o644, bytes: Buffer.from("second") },
			{ name: "root/a", mode: 0o755, bytes: Buffer.from("first") },
		]);
		const secondTar = deterministicTar([
			{ name: "root/a", mode: 0o755, bytes: Buffer.from("first") },
			{ name: "root/b", mode: 0o644, bytes: Buffer.from("second") },
		]);
		expect(firstTar).toEqual(secondTar);

		const root = temporaryDirectory();
		const source = path.join(root, "source");
		const artifact = path.join(root, "artifact");
		writeFileSync(source, "native-binary");
		createBuildArtifact({
			binaryPath: source,
			directory: artifact,
			executableName: "maligator",
			version: MALIGATOR_VERSION,
			target: "x86_64-unknown-linux-gnu",
			production: true,
		});
		const first = createReleaseArchive(
			artifact,
			path.join(root, "first.tar.gz"),
			"maligator-release",
		);
		const second = createReleaseArchive(
			artifact,
			path.join(root, "second.tar.gz"),
			"maligator-release",
		);
		expect(readFileSync(first.archivePath)).toEqual(readFileSync(second.archivePath));
		expect(
			gunzipSync(readFileSync(first.archivePath)).includes(
				Buffer.from("maligator-release/bin/maligator"),
			),
		).toBe(true);
	});
});

describe("alpha versions", () => {
	it("increments only the numeric alpha suffix", () => {
		expect(nextAlphaVersion("0.1.0-alpha.1")).toBe("0.1.0-alpha.2");
		expect(nextAlphaVersion("2.3.4-alpha.99")).toBe("2.3.4-alpha.100");
	});

	it("rejects every non-alpha version shape", () => {
		for (const version of ["0.1.0", "0.1.0-beta.1", "0.1.0-alpha"]) {
			expect(() => nextAlphaVersion(version)).toThrow("must be an alpha prerelease");
		}
	});
});

describe("release targets", () => {
	it("defaults to Apple Silicon macOS and retains an explicit complete matrix", () => {
		expect(selectReleaseTargetTriples([])).toEqual(["aarch64-apple-darwin"]);
		expect(selectReleaseTargetTriples(["--all-targets"])).toEqual([
			"aarch64-apple-darwin",
			"x86_64-apple-darwin",
			"aarch64-unknown-linux-gnu",
			"x86_64-unknown-linux-gnu",
		]);
	});

	it("accepts one known target and rejects ambiguous selections", () => {
		expect(selectReleaseTargetTriples(["--target", "x86_64-unknown-linux-gnu"])).toEqual([
			"x86_64-unknown-linux-gnu",
		]);
		expect(() => selectReleaseTargetTriples(["--target", "unknown"])).toThrow(
			"unsupported release target",
		);
		expect(() => selectReleaseTargetTriples(["--all-targets", "--target"])).toThrow(
			"usage",
		);
	});
});

describe("npm launcher", () => {
	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"executes the current platform package without changing arguments",
		() => {
			const root = temporaryDirectory();
			const launcherDirectory = path.join(root, "cli");
			const platformPackage = `cli-${process.platform}-${process.arch}`;
			const binaryDirectory = path.join(
				launcherDirectory,
				"node_modules/@maligator",
				platformPackage,
				"bin",
			);
			mkdirSync(path.join(launcherDirectory, "bin"), { recursive: true });
			mkdirSync(binaryDirectory, { recursive: true });
			const launcher = path.join(launcherDirectory, "bin/maligator.js");
			const binary = path.join(binaryDirectory, "maligator");
			writeFileSync(
				launcher,
				readFileSync(
					path.resolve(import.meta.dirname, "../npm/cli/bin/maligator.js"),
					"utf-8",
				),
			);
			writeFileSync(binary, "#!/bin/sh\nprintf '%s\\n' \"$1|$2\"\n");
			chmodSync(binary, 0o755);

			const result = spawnSync(process.execPath, [launcher, "alpha", "two words"], {
				encoding: "utf-8",
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe("alpha|two words\n");
		},
	);
});
