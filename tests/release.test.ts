import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { defineBuild } from "../npm/cli/index.js";
import { createReleaseArchive, deterministicTar } from "../scripts/release-archive.ts";
import { nextAlphaVersion } from "../scripts/release-version.ts";
import {
	assertGitHubTrustedPublishingEnvironment,
	assertReleaseTag,
	createLauncherPackageJson,
	expectedReleaseTag,
	matchingPublishedIntegrity,
	NPM_WEB_LOGIN_ARGUMENTS,
	parseReleaseManifest,
	parsePublishReleaseArguments,
	preparedTarballIntegrity,
	selectReleaseTargetTriples,
} from "../scripts/release.ts";
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
		const profile = path.join(root, "profile.json");
		writeFileSync(source, "native-binary");
		writeFileSync(license, "MIT");
		writeFileSync(profile, '{"schema":1}\n');
		chmodSync(source, 0o755);

		const result = createBuildArtifact({
			binaryPath: source,
			directory,
			executableName: "maligator",
			licensePath: license,
			version: MALIGATOR_VERSION,
			target: "aarch64-apple-darwin",
			production: true,
			additionalFiles: [{ sourcePath: profile, path: "profile.json" }],
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
				{
					path: "profile.json",
					sha256: "6b823fa123b900a4139de2101277275af8329f3a3d34c00ef3bf4fc6bf60287e",
					bytes: 13,
				},
			],
		});
		expect(readFileSync(path.join(directory, "LICENSE"), "utf-8")).toBe("MIT");
		expect(readFileSync(path.join(directory, "profile.json"), "utf-8")).toBe(
			'{"schema":1}\n',
		);
		expect(readFileSync(result.checksumsPath, "utf-8")).toBe(
			`${result.manifest.files[0]!.sha256}  bin/maligator\n` +
				`${result.manifest.files[1]!.sha256}  LICENSE\n` +
				`${result.manifest.files[2]!.sha256}  profile.json\n`,
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
	it("requires web authentication before release publishing", () => {
		expect(NPM_WEB_LOGIN_ARGUMENTS).toEqual(["login", "--auth-type", "web"]);
	});

	it("reserves trusted publishing for a GitHub Actions OIDC environment", () => {
		expect(
			parsePublishReleaseArguments(["--confirm", "0.1.0-alpha.8"], "0.1.0-alpha.8"),
		).toBe("web");
		expect(
			parsePublishReleaseArguments(
				["--confirm", "0.1.0-alpha.8", "--trusted-publishing"],
				"0.1.0-alpha.8",
			),
		).toBe("trusted-publishing");
		expect(() =>
			parsePublishReleaseArguments(
				["--confirm", "0.1.0-alpha.7", "--trusted-publishing"],
				"0.1.0-alpha.8",
			),
		).toThrow("--confirm 0.1.0-alpha.8");
		expect(() =>
			assertGitHubTrustedPublishingEnvironment(
				{ GITHUB_ACTIONS: "true" },
				"0.1.0-alpha.8",
			),
		).toThrow("id-token: write");
		expect(() =>
			assertGitHubTrustedPublishingEnvironment(
				{
					GITHUB_ACTIONS: "true",
					ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
				},
				"0.1.0-alpha.8",
			),
		).toThrow("release tag or main retry");
		expect(() =>
			assertGitHubTrustedPublishingEnvironment(
				{
					GITHUB_ACTIONS: "true",
					ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
					GITHUB_REF_TYPE: "tag",
					GITHUB_REF_NAME: "v0.1.0-alpha.8",
				},
				"0.1.0-alpha.8",
			),
		).not.toThrow();
		expect(() =>
			assertGitHubTrustedPublishingEnvironment(
				{
					GITHUB_ACTIONS: "true",
					ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
					GITHUB_EVENT_NAME: "workflow_dispatch",
					GITHUB_REF_TYPE: "branch",
					GITHUB_REF: "refs/heads/main",
					MALIGATOR_RELEASE_TAG: "v0.1.0-alpha.8",
				},
				"0.1.0-alpha.8",
			),
		).not.toThrow();
	});

	it("requires an exact v-prefixed tag for the package version", () => {
		expect(expectedReleaseTag("0.1.0-alpha.8")).toBe("v0.1.0-alpha.8");
		expect(() => assertReleaseTag("v0.1.0-alpha.8", "0.1.0-alpha.8")).not.toThrow();
		expect(() => assertReleaseTag("v0.1.0-alpha.7", "0.1.0-alpha.8")).toThrow(
			"release tag must be v0.1.0-alpha.8",
		);
	});

	it("rejects unsafe or malformed release asset manifests", () => {
		const valid = {
			schema: 2,
			version: "0.1.0-alpha.8",
			targets: ["aarch64-apple-darwin"],
			packages: [
				{
					name: "@maligator/cli-darwin-arm64",
					file: "maligator-cli-darwin-arm64-0.1.0-alpha.8.tgz",
					sha256: "a".repeat(64),
				},
			],
		};
		expect(parseReleaseManifest(valid, "0.1.0-alpha.8")).toEqual(valid);
		expect(() =>
			parseReleaseManifest(
				{
					...valid,
					packages: [{ ...valid.packages[0], file: "../../package.json" }],
				},
				"0.1.0-alpha.8",
			),
		).toThrow("invalid packed package manifest");
		expect(() => parseReleaseManifest(valid, "0.1.0-alpha.9")).toThrow(
			"does not match the release version",
		);
	});

	it("publishes prepared GitHub Release assets without a stored npm token", () => {
		const workflow = readFileSync(
			path.resolve(import.meta.dirname, "../.github/workflows/npm-release.yml"),
			"utf-8",
		);
		expect(workflow).toContain("release:");
		expect(workflow).toContain("types: [published]");
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("runs-on: ubuntu-latest");
		expect(workflow).toContain("timeout-minutes: 60");
		expect(workflow).toContain("isImmutable");
		expect(workflow).toContain('git rev-list -n 1 "$RELEASE_TAG"');
		expect(workflow).toContain("git merge-base --is-ancestor");
		expect(workflow).toContain("release:verify-tag");
		expect(workflow).toContain("gh release download");
		expect(workflow).not.toContain("release:build");
		expect(workflow).not.toContain("release:pack");
		expect(workflow).not.toContain("release:smoke");
		expect(workflow).toContain("--trusted-publishing");
		expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
	});

	it("resumes only when an existing package has identical tarball contents", () => {
		const tarball = Buffer.from("prepared npm tarball");
		const integrity = preparedTarballIntegrity(tarball);
		expect(matchingPublishedIntegrity("@maligator/cli", undefined, tarball)).toBe(false);
		expect(matchingPublishedIntegrity("@maligator/cli", integrity, tarball)).toBe(true);
		expect(() =>
			matchingPublishedIntegrity(
				"@maligator/cli",
				preparedTarballIntegrity(Buffer.from("different tarball")),
				tarball,
			),
		).toThrow("already published with different contents");
	});

	it("publishes the helper runtime and TypeScript declarations", () => {
		const config = { entry: "src/index.ts" };
		expect(defineBuild(config)).toBe(config);

		const manifest = createLauncherPackageJson("0.1.0-alpha.2", [
			"@maligator/cli-darwin-arm64",
		]);
		expect(manifest.types).toBe("./index.d.ts");
		expect(manifest.exports).toEqual({
			".": {
				types: "./index.d.ts",
				import: "./index.js",
			},
		});
		expect(manifest.files).toEqual([
			"bin/maligator.js",
			"index.js",
			"index.d.ts",
			"platform-api.d.ts",
			"process-api.d.ts",
			"test-api.d.ts",
			"README.md",
			"LICENSE",
		]);
		expect(manifest.optionalDependencies).toEqual({
			"@maligator/cli-darwin-arm64": "0.1.0-alpha.2",
		});
	});

	it("ships documented test declarations and runner guidance", () => {
		const declarations = readFileSync(
			path.resolve(import.meta.dirname, "../src/test-api.d.ts"),
			"utf-8",
		);
		expect(declarations).toContain('declare module "maligator:test"');
		expect(declarations).toContain("Returned promises are awaited by the runner");
		expect(declarations).toContain("focused test");
		expect(declarations).toContain("zero-based row");

		const readme = readFileSync(
			path.resolve(import.meta.dirname, "../npm/cli/README.md"),
			"utf-8",
		);
		expect(readme).toContain("## Testing");
		expect(readme).toContain('from "maligator:test"');
		expect(readme).toContain("maligator test --shuffle 18492");
		expect(readme).toContain("Test results are never cached");
		expect(readme).toContain("## Build cache");
	});

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
