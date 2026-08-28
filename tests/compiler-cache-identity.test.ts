import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilerImplementationDigestForRoot } from "../src/compiler-cache-identity.ts";
import { walkDirectoryTree } from "../src/file-tree.ts";

const temporaryDirectories: Array<string> = [];

function compilerFixture(): { sourceRoot: string; cacheDirectory: string } {
	const root = mkdtempSync(path.join(tmpdir(), "mal-compiler-identity-"));
	temporaryDirectories.push(root);
	const sourceRoot = path.join(root, "src");
	const cacheDirectory = path.join(root, "cache");
	mkdirSync(path.join(sourceRoot, "compiler"), { recursive: true });
	writeFileSync(path.join(sourceRoot, "compiler", "compile.ts"), "export const n = 1;\n");
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
});
