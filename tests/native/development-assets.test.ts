import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { includeConfiguredAssets } from "../../src/assets.ts";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { buildDerivationFromConfig } from "../../src/build-config.ts";
import {
	BuildCompilationSession,
	compileBuildFrontend,
} from "../../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import { cacheDevelopmentAssets } from "../../src/development-assets.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "mal-development-assets-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("external development assets", () => {
	it("materializes content-addressed snapshots from a relocatable development image", () => {
		const cacheDirectory = path.join(root, "cache");
		const assetPath = path.join(root, "hello.txt");
		const entrypoint = path.join(root, "entry.mts");
		mkdirSync(root, { recursive: true });
		writeFileSync(assetPath, "hello external asset\n");
		writeFileSync(
			entrypoint,
			`import { readFileSync } from "node:fs";
console.log(readFileSync(mal.assets.materialize("hello"), "utf-8"));
`,
		);
		const assetConfig = {
			hello: { type: "file" as const, path: assetPath },
		};
		const config = resolveBuildConfig({
			assets: assetConfig,
			engine: { realms: false, intl: { enabled: false } },
			surface: { node: true, webPlatform: false, maligator: true },
		});
		const session = new BuildCompilationSession();
		session.useCacheDirectory(cacheDirectory);
		const assets = includeConfiguredAssets(assetConfig, root, {
			cacheDirectory,
			session,
		});
		const manifest = cacheDevelopmentAssets(assets, cacheDirectory)!;
		const frontend = compileBuildFrontend({
			entrypoint,
			config,
			stripTypes: stripCompactTypes,
			stripperIdentity: "development-assets-test",
			cacheDirectory,
			session,
			optimization: "development",
			relocatable: true,
		});
		const derivation = buildDerivationFromConfig(config);
		const runner = buildDevelopmentRunner(
			resolveNativeBuildContext({ features: derivation.features }),
			false,
			derivation.cacheSuffix,
		).binaryPath;
		const result = spawnSync(
			runner,
			[
				"--maligator-internal-run-wires-assets",
				String(frontend.runtimeArtifacts.length),
				manifest,
				entrypoint,
				...frontend.runtimeArtifacts.map((artifact) => artifact.path),
			],
			{ encoding: "utf-8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("hello external asset");
	}, 120_000);
});

it("materializes directory membership changes from one unchanged development image", () => {
	const directory = path.join(root, "membership");
	const tree = path.join(directory, "tree");
	const entry = path.join(directory, "entry.mts");
	mkdirSync(path.join(tree, "empty"), { recursive: true });
	writeFileSync(path.join(tree, "keep.txt"), "keep");
	writeFileSync(path.join(tree, "empty/ignored.bin"), "renamed");
	writeFileSync(
		entry,
		`import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const root = mal.assets.materialize("content");
function walk(directory, prefix) {
 const result = [];
 for (const name of readdirSync(directory).sort()) {
  if (name === ".maligator-asset-complete") continue;
  const file = join(directory, name);
  const relative = prefix + name;
  if (statSync(file).isDirectory()) result.push(...walk(file, relative + "/"));
  else result.push(relative + ":" + readFileSync(file, "utf8"));
 }
 return result;
}
console.log(walk(root, "").join("|"));
`,
	);
	const configAssets = {
		content: { type: "directory" as const, path: tree, include: ["**/*.txt"] },
	};
	const config = resolveBuildConfig({
		assets: configAssets,
		engine: { realms: false, intl: { enabled: false } },
		surface: { node: true, webPlatform: false, maligator: true },
	});
	const session = new BuildCompilationSession();
	const cacheDirectory = path.join(directory, "cache");
	session.useCacheDirectory(cacheDirectory);
	const frontend = compileBuildFrontend({
		entrypoint: entry,
		config,
		stripTypes: stripCompactTypes,
		stripperIdentity: "asset-membership-test",
		cacheDirectory,
		session,
		optimization: "development",
		relocatable: true,
	});
	const derivation = buildDerivationFromConfig(config);
	const runner = buildDevelopmentRunner(
		resolveNativeBuildContext({ features: derivation.features }),
		false,
		derivation.cacheSuffix,
	).binaryPath;
	const observe = () => {
		const included = includeConfiguredAssets(configAssets, directory, {
			cacheDirectory,
			session,
		});
		const manifest = cacheDevelopmentAssets(included, cacheDirectory)!;
		const result = spawnSync(
			runner,
			[
				"--maligator-internal-run-wires-assets",
				String(frontend.runtimeArtifacts.length),
				manifest,
				entry,
				...frontend.runtimeArtifacts.map((artifact) => artifact.path),
			],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
		return result.stdout.trim();
	};
	expect(observe()).toBe("keep.txt:keep");
	writeFileSync(path.join(tree, "empty/added.txt"), "added");
	expect(observe()).toBe("empty/added.txt:added|keep.txt:keep");
	renameSync(path.join(tree, "empty/ignored.bin"), path.join(tree, "empty/renamed.txt"));
	expect(observe()).toBe("empty/added.txt:added|empty/renamed.txt:renamed|keep.txt:keep");
	rmSync(path.join(tree, "empty/added.txt"));
	mkdirSync(path.join(tree, "new"));
	writeFileSync(path.join(tree, "new/child.txt"), "child");
	expect(observe()).toBe("empty/renamed.txt:renamed|keep.txt:keep|new/child.txt:child");
}, 120_000);
