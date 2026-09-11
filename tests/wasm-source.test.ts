import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactDigest } from "../src/artifact-store.ts";
import { resolveBuildConfig } from "../src/build-config.ts";
import { prepareWasmSource } from "../src/wasm-source.ts";

const root = path.resolve(import.meta.dirname, "..");
const config = resolveBuildConfig({
	engine: { eval: false, realms: false, temporal: false, intl: { enabled: false } },
	surface: { node: false, webPlatform: false, maligator: false },
});
const directories: Array<string> = [];

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-wasm-source-"));
	directories.push(directory);
	for (const name of ["src", "node_modules", "package.json"])
		symlinkSync(path.join(root, name), path.join(directory, name));
	for (const [name, source] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
		writeFileSync(path.join(directory, name), source);
	}
	return {
		directory,
		prepare: (entry = "entry.mjs") =>
			prepareWasmSource(directory, entry, config, path.join(directory, "cache")),
	};
}

describe("Wasm source cache identity", () => {
	it("shares identical module programs and emitted C across checkout paths", () => {
		const files = {
			"entry.mjs": 'import { value } from "./dep.mjs"; globalThis.value = () => value;',
			"dep.mjs": 'export const value = "portable";',
		};
		const first = fixture(files).prepare();
		const second = fixture(files).prepare();
		expect(second.sourceIdentity).toBe(first.sourceIdentity);
		expect(second.compilerHash).toBe(first.compilerHash);
		expect(second.producer).toBe(first.producer);
		expect(second.compile(() => {}).map(artifactDigest)).toEqual(
			first.compile(() => {}).map(artifactDigest),
		);
	});

	it("distinguishes entrypoints reaching the same module set", () => {
		const project = fixture({
			"a.mjs": 'import "./b.mjs"; globalThis.value = () => "a";',
			"b.mjs": 'import "./a.mjs"; globalThis.value = () => "b";',
		});
		expect(project.prepare("a.mjs").sourceIdentity).not.toBe(
			project.prepare("b.mjs").sourceIdentity,
		);
	});

	it("keeps observable import.meta URLs in identity and generated program data", () => {
		const files = { "entry.mjs": "globalThis.url = () => import.meta.url;" };
		const firstProject = fixture(files);
		const secondProject = fixture(files);
		const first = firstProject.prepare();
		const second = secondProject.prepare();
		expect(second.sourceIdentity).not.toBe(first.sourceIdentity);
		expect(second.compile(() => {}).map(artifactDigest)).not.toEqual(
			first.compile(() => {}).map(artifactDigest),
		);
	});

	it("distinguishes package goals for the same source text", () => {
		const files = {
			"entry.mjs": 'import "./dep/entry.js";',
			"dep/entry.js": "globalThis.value = 1;",
			"dep/package.json": '{"type":"module"}',
		};
		const first = fixture(files).prepare();
		const second = fixture({
			...files,
			"dep/package.json": '{"type":"commonjs"}',
		}).prepare();
		expect(second.sourceIdentity).not.toBe(first.sourceIdentity);
	});
});
