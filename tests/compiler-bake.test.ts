import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	compilerEntrypointSourceFiles,
	ensureCompilerArtifacts,
	ensureCompilerWire,
} from "../src/compiler-bake.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";

/**
 * The stripper module is keyed by name, not by import: it erases every compiler
 * source before a bake without the entrypoint ever importing it.
 */
const stripperModule = "compiler/frontend/compact-type-strip.ts";

function compilerFixture(meriyah = "7.1.0"): {
	root: string;
	sourceDirectory: string;
	entrypoint: string;
	stripper: string;
} {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-compiler-source-"));
	const sourceDirectory = path.join(root, "src");
	const entrypoint = path.join(sourceDirectory, "entry.mts");
	const stripper = path.join(sourceDirectory, stripperModule);
	mkdirSync(path.dirname(stripper), { recursive: true });
	writeFileSync(entrypoint, "export const compiler = 1;\n");
	writeFileSync(path.join(sourceDirectory, "helper.ts"), "export const helper = 1;\n");
	writeFileSync(stripper, "export const stripCompactTypes = (source) => source;\n");
	writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ dependencies: { meriyah } }),
	);
	return { root, sourceDirectory, entrypoint, stripper };
}

describe("compiler wire provisioning", () => {
	it("uses only the explicit source root, independent of cwd", () => {
		const fixture = compilerFixture();
		const cacheRoot = path.join(fixture.root, "wire-cache");
		const moduleUrl = pathToFileURL(path.resolve("src/compiler-bake.ts")).href;
		const script = `
			import { ensureCompilerWire } from ${JSON.stringify(moduleUrl)};
			process.stdout.write(ensureCompilerWire({
				kind: "source",
				sourceDirectory: process.env.SOURCE_DIRECTORY,
				entrypoint: process.env.ENTRYPOINT,
				cacheRoot: process.env.CACHE_ROOT,
				bake: () => new Uint8Array([77, 65, 76]),
			}));
		`;
		const invoke = (cwd: string): string =>
			execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
				cwd,
				encoding: "utf-8",
				env: {
					...process.env,
					SOURCE_DIRECTORY: fixture.sourceDirectory,
					ENTRYPOINT: fixture.entrypoint,
					CACHE_ROOT: cacheRoot,
				},
			});
		const firstCwd = mkdtempSync(path.join(os.tmpdir(), "mal-compiler-cwd-a-"));
		const secondCwd = mkdtempSync(path.join(os.tmpdir(), "mal-compiler-cwd-b-"));

		expect(invoke(firstCwd)).toBe(invoke(secondCwd));
	});

	it("bakes lazily and invalidates dependency, entrypoint, and source identity", () => {
		const fixture = compilerFixture();
		const cacheRoot = path.join(fixture.root, "wire-cache");
		let bakeCount = 0;
		const sourceInput = () => ({
			kind: "source" as const,
			sourceDirectory: fixture.sourceDirectory,
			entrypoint: fixture.entrypoint,
			cacheRoot,
			bake: () => {
				bakeCount++;
				return new Uint8Array([bakeCount]);
			},
		});

		const first = ensureCompilerWire(sourceInput());
		expect(ensureCompilerWire(sourceInput())).toBe(first);
		expect(bakeCount).toBe(1);

		writeFileSync(
			path.join(fixture.root, "package.json"),
			JSON.stringify({ dependencies: { meriyah: "7.2.0" } }),
		);
		const dependencyChanged = ensureCompilerWire(sourceInput());
		expect(dependencyChanged).not.toBe(first);
		expect(bakeCount).toBe(2);

		writeFileSync(
			fixture.stripper,
			"export const stripCompactTypes = (source) => source.trim();\n",
		);
		const stripperChanged = ensureCompilerWire(sourceInput());
		expect(stripperChanged).not.toBe(dependencyChanged);

		writeFileSync(
			path.join(fixture.sourceDirectory, "helper.ts"),
			"export const helper = 2;\n",
		);
		const sourceChanged = ensureCompilerWire(sourceInput());
		expect(sourceChanged).not.toBe(stripperChanged);
		expect(bakeCount).toBe(4);

		writeFileSync(fixture.entrypoint, "export const compiler = 2;\n");
		const entrypointSourceChanged = ensureCompilerWire(sourceInput());
		expect(entrypointSourceChanged).not.toBe(sourceChanged);

		const alternateEntrypoint = path.join(fixture.sourceDirectory, "alternate.mts");
		writeFileSync(alternateEntrypoint, "export const compiler = 2;\n");
		const primaryWithAlternatePresent = ensureCompilerWire(sourceInput());
		const entrypointChanged = ensureCompilerWire({
			...sourceInput(),
			entrypoint: alternateEntrypoint,
		});
		expect(entrypointChanged).not.toBe(primaryWithAlternatePresent);
		expect(bakeCount).toBe(7);
	});

	it("can key source bakes to the imported compiler cone", () => {
		const fixture = compilerFixture();
		const cacheRoot = path.join(fixture.root, "wire-cache");
		const helper = path.join(fixture.sourceDirectory, "cone-helper.mts");
		const unrelated = path.join(fixture.sourceDirectory, "unrelated.ts");
		writeFileSync(
			fixture.entrypoint,
			'import { helper } from "./cone-helper.mts";\nexport const compiler = helper;\n',
		);
		writeFileSync(helper, "export const helper = 1;\n");
		writeFileSync(unrelated, "export const unrelated = 1;\n");
		const sourceFiles = compilerEntrypointSourceFiles(
			fixture.sourceDirectory,
			fixture.entrypoint,
			stripCompactTypes,
		);
		expect(sourceFiles).toContain(fixture.stripper);
		let bakeCount = 0;
		const sourceInput = () => ({
			kind: "source" as const,
			sourceDirectory: fixture.sourceDirectory,
			entrypoint: fixture.entrypoint,
			sourceFiles,
			cacheRoot,
			bake: () => new Uint8Array([++bakeCount]),
		});

		const first = ensureCompilerWire(sourceInput());
		writeFileSync(unrelated, "export const unrelated = 2;\n");
		expect(ensureCompilerWire(sourceInput())).toBe(first);
		expect(bakeCount).toBe(1);

		writeFileSync(helper, "export const helper = 2;\n");
		const helperChanged = ensureCompilerWire(sourceInput());
		expect(helperChanged).not.toBe(first);
		expect(bakeCount).toBe(2);

		writeFileSync(
			fixture.stripper,
			"export const stripCompactTypes = (source) => source.trim();\n",
		);
		expect(ensureCompilerWire(sourceInput())).not.toBe(helperChanged);
		expect(bakeCount).toBe(3);
	});

	it("deduplicates equivalent bytes and prebuilt content", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-compiler-content-"));
		const cacheRoot = path.join(root, "wire-cache");
		const bytes = new Uint8Array([0x4d, 0x41, 0x4c]);
		const firstPrebuilt = path.join(root, "first.malw");
		const secondPrebuilt = path.join(root, "second.malw");
		writeFileSync(firstPrebuilt, bytes);
		writeFileSync(secondPrebuilt, bytes);

		const fromBytes = ensureCompilerWire({ kind: "bytes", bytes, cacheRoot });
		const fromFirstPath = ensureCompilerWire({
			kind: "prebuilt",
			path: firstPrebuilt,
			cacheRoot,
		});
		const fromSecondPath = ensureCompilerWire({
			kind: "prebuilt",
			path: secondPrebuilt,
			cacheRoot,
		});

		expect(fromFirstPath).toBe(fromBytes);
		expect(fromSecondPath).toBe(fromBytes);
	});

	it("publishes and repairs a native companion without rebaking the wire separately", () => {
		const fixture = compilerFixture();
		const cacheRoot = path.join(fixture.root, "wire-cache");
		const nativeHostSource = path.join(
			fixture.sourceDirectory,
			"compiler",
			"native-host.ts",
		);
		writeFileSync(nativeHostSource, "export const nativeHost = 1;\n");
		const source = "function add(a, b) { return a + b; } add(20, 22);";
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"native-compiler-fixture.js",
			parseScript(source, { strict: false }),
		);
		const program = compileSemanticProgramToProgramImage(semantic);
		let programBakes = 0;
		const input = () => ({
			kind: "source" as const,
			sourceDirectory: fixture.sourceDirectory,
			entrypoint: fixture.entrypoint,
			sourceFiles: [fixture.entrypoint, fixture.stripper],
			cacheRoot,
			bake: () => {
				throw new Error("wire-only bake should not run");
			},
			bakeProgram: () => {
				programBakes++;
				return program;
			},
		});
		const portableWire = ensureCompilerWire({
			kind: "source",
			sourceDirectory: fixture.sourceDirectory,
			entrypoint: fixture.entrypoint,
			sourceFiles: [fixture.entrypoint, fixture.stripper],
			cacheRoot,
			bake: () => new Uint8Array([0x4d, 0x41, 0x4c]),
		});

		const first = ensureCompilerArtifacts(input());
		expect(first.wirePath).not.toBe(portableWire);
		expect(first.nativeSourcePaths.length).toBeGreaterThan(1);
		expect(programBakes).toBe(1);
		expect(ensureCompilerArtifacts(input())).toEqual(first);
		expect(programBakes).toBe(1);

		writeFileSync(first.nativeSourcePaths[1]!, "corrupt\n");
		const repaired = ensureCompilerArtifacts(input());
		expect(repaired.wirePath).toBe(first.wirePath);
		expect(readFileSync(repaired.nativeSourcePaths[1]!, "utf-8")).not.toBe("corrupt\n");
		expect(programBakes).toBe(2);

		writeFileSync(nativeHostSource, "export const nativeHost = 2;\n");
		expect(ensureCompilerArtifacts(input()).wirePath).not.toBe(first.wirePath);
		expect(programBakes).toBe(3);
	});

	it("replaces empty hits atomically and rejects empty wires", () => {
		const fixture = compilerFixture();
		const cacheRoot = path.join(fixture.root, "wire-cache");
		let bakeCount = 0;
		const input = {
			kind: "source" as const,
			sourceDirectory: fixture.sourceDirectory,
			entrypoint: fixture.entrypoint,
			cacheRoot,
			bake: () => {
				bakeCount++;
				return new Uint8Array([0x4d, bakeCount]);
			},
		};
		const wirePath = ensureCompilerWire(input);
		writeFileSync(wirePath, new Uint8Array());

		expect(ensureCompilerWire(input)).toBe(wirePath);
		expect(bakeCount).toBe(2);
		expect(readFileSync(wirePath)).toEqual(Buffer.from([0x4d, 2]));
		expect(
			readdirSync(path.dirname(wirePath)).filter((name) => name.startsWith(".publish-")),
		).toEqual([]);
		expect(() =>
			ensureCompilerWire({ kind: "bytes", bytes: new Uint8Array(), cacheRoot }),
		).toThrow("compiler wire must not be empty");
	});

	it("recovers content-addressed and source entries from digest corruption", () => {
		const fixture = compilerFixture();
		const cacheRoot = path.join(fixture.root, "wire-cache");
		const bytes = new Uint8Array([0x4d, 0x41, 0x4c]);
		const contentPath = ensureCompilerWire({ kind: "bytes", bytes, cacheRoot });
		writeFileSync(contentPath, new Uint8Array([1, 2, 3]));
		expect(ensureCompilerWire({ kind: "bytes", bytes, cacheRoot })).toBe(contentPath);
		expect(readFileSync(contentPath)).toEqual(Buffer.from(bytes));

		let bakeCount = 0;
		const sourceInput = () => ({
			kind: "source" as const,
			sourceDirectory: fixture.sourceDirectory,
			entrypoint: fixture.entrypoint,
			cacheRoot,
			bake: () => new Uint8Array([0x4d, ++bakeCount]),
		});
		const sourcePath = ensureCompilerWire(sourceInput());
		writeFileSync(sourcePath, new Uint8Array([9, 9]));
		expect(ensureCompilerWire(sourceInput())).toBe(sourcePath);
		expect(bakeCount).toBe(2);

		writeFileSync(path.join(path.dirname(sourcePath), "artifact.json"), "{}");
		expect(ensureCompilerWire(sourceInput())).toBe(sourcePath);
		expect(bakeCount).toBe(3);
		expect(
			JSON.parse(
				readFileSync(path.join(path.dirname(sourcePath), "artifact.json"), "utf-8"),
			),
		).toMatchObject({
			schema: 2,
		});
	});
});
