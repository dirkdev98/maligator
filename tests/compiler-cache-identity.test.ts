import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	compilerConfigurationIdentity,
	compilerImplementationDigestForRoot,
	compilerProducerImplementationDigestForRoot,
} from "../src/compiler-cache-identity.ts";
import { walkDirectoryTree } from "../src/file-tree.ts";

const temporaryDirectories: Array<string> = [];

function compilerFixture(): { sourceRoot: string; cacheDirectory: string } {
	const root = mkdtempSync(path.join(tmpdir(), "mal-compiler-identity-"));
	temporaryDirectories.push(root);
	const sourceRoot = path.join(root, "src");
	const cacheDirectory = path.join(root, "cache");
	mkdirSync(path.join(sourceRoot, "compiler"), { recursive: true });
	mkdirSync(path.join(sourceRoot, "testing"), { recursive: true });
	writeFileSync(path.join(sourceRoot, "compiler", "compile.ts"), "export const n = 1;\n");
	writeFileSync(
		path.join(sourceRoot, "build-frontend-cache.ts"),
		'import { n } from "./compiler/compile.ts";\nexport const build = n;\n',
	);
	writeFileSync(
		path.join(sourceRoot, "testing", "cache.ts"),
		'export const test = "test-only";\n',
	);
	writeFileSync(path.join(sourceRoot, "build-config-error.ts"), "export class E {}\n");
	writeFileSync(path.join(sourceRoot, "utils.ts"), "export const debug = false;\n");
	writeFileSync(
		path.join(root, "package.json"),
		`${JSON.stringify({ dependencies: { meriyah: "7.1.0" } })}\n`,
	);
	return { sourceRoot, cacheDirectory };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("compiler cache identity", () => {
	it("ignores runner sources while invalidating compiler inputs", () => {
		const fixture = compilerFixture();
		const initial = compilerImplementationDigestForRoot(
			fixture.sourceRoot,
			fixture.cacheDirectory,
		);
		mkdirSync(path.join(fixture.sourceRoot, "test262"));
		writeFileSync(
			path.join(fixture.sourceRoot, "test262", "constants.ts"),
			"export const timeout = 30_000;\n",
		);
		expect(
			compilerImplementationDigestForRoot(fixture.sourceRoot, fixture.cacheDirectory),
		).toBe(initial);

		writeFileSync(
			path.join(fixture.sourceRoot, "compiler", "compile.ts"),
			"export const n = 2;\n",
		);
		expect(
			compilerImplementationDigestForRoot(fixture.sourceRoot, fixture.cacheDirectory),
		).not.toBe(initial);
	});

	it("tracks every runtime source imported from outside the compiler tree", () => {
		const sourceRoot = path.resolve(import.meta.dirname, "../src");
		const compilerRoot = path.join(sourceRoot, "compiler");
		const externalSources = new Set<string>();
		walkDirectoryTree(compilerRoot, ({ fullPath, dirent }) => {
			if (!dirent.name.endsWith(".ts") && !dirent.name.endsWith(".mts")) return;
			const source = readFileSync(fullPath, "utf8");
			const specifiers = [
				...source.matchAll(
					/^\s*(?:import|export)\s+(?!type\b).*?\sfrom\s+["'](\.\.?\/[^"']+)["']/gm,
				),
				...source.matchAll(/^\s*import\s+["'](\.\.?\/[^"']+)["']/gm),
			].map((match) => match[1]!);
			for (const specifier of specifiers) {
				const imported = path.resolve(path.dirname(fullPath), specifier);
				if (!imported.startsWith(`${compilerRoot}${path.sep}`)) {
					externalSources.add(path.relative(sourceRoot, imported));
				}
			}
		});
		expect([...externalSources].sort()).toEqual(["build-config-error.ts", "utils.ts"]);
	});

	it("invalidates only a producer's transitive source cone", () => {
		const fixture = compilerFixture();
		const initial = compilerProducerImplementationDigestForRoot(
			"build-frontend",
			fixture.sourceRoot,
			fixture.cacheDirectory,
		);
		writeFileSync(
			path.join(fixture.sourceRoot, "testing", "cache.ts"),
			'export const test = "changed outside the build cone";\n',
		);
		expect(
			compilerProducerImplementationDigestForRoot(
				"build-frontend",
				fixture.sourceRoot,
				fixture.cacheDirectory,
			),
		).toBe(initial);

		writeFileSync(
			path.join(fixture.sourceRoot, "compiler", "compile.ts"),
			"export const n = 2;\n",
		);
		expect(
			compilerProducerImplementationDigestForRoot(
				"build-frontend",
				fixture.sourceRoot,
				fixture.cacheDirectory,
			),
		).not.toBe(initial);
	});

	it("projects exactly the configuration consumed before native emission", () => {
		const base = JSON.stringify(compilerConfigurationIdentity(resolveBuildConfig({})));
		const nativeOnly = resolveBuildConfig({
			entry: "src/main.ts",
			outputName: "application",
			assets: { data: { type: "file", path: "data.json" } },
			engine: { intl: { features: ["collator"], languages: ["en"] } },
		});
		expect(JSON.stringify(compilerConfigurationIdentity(nativeOnly))).toBe(base);

		const frontendDimensions = [
			resolveBuildConfig({ modules: { aliases: { package: "./replacement.ts" } } }),
			resolveBuildConfig({ engine: { primordials: "mutable" } }),
			resolveBuildConfig({ engine: { eval: true } }),
			resolveBuildConfig({ engine: { realms: true } }),
			resolveBuildConfig({ engine: { regexp: false } }),
			resolveBuildConfig({ engine: { temporal: true } }),
			resolveBuildConfig({ engine: { intl: { enabled: true } } }),
			resolveBuildConfig({ surface: { webPlatform: true } }),
			resolveBuildConfig({ surface: { node: true } }),
			resolveBuildConfig({ surface: { maligator: false } }),
		];
		for (const config of frontendDimensions) {
			expect(JSON.stringify(compilerConfigurationIdentity(config))).not.toBe(base);
		}
	});
});
