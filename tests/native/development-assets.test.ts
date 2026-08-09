import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { cacheDevelopmentAssets } from "../../src/development-assets.ts";
import { buildDevelopmentRunner } from "../../src/local-build.ts";
import { resolveNativeBuildContext } from "../../src/native-build-context.ts";
import { stripTypesWithTypeScript } from "../../src/typescript-strip.ts";

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
			stripTypes: stripTypesWithTypeScript,
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
				String(frontend.artifacts.length),
				manifest,
				...frontend.artifacts.map((artifact) => artifact.path),
			],
			{ encoding: "utf-8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("hello external asset");
	}, 120_000);
});
