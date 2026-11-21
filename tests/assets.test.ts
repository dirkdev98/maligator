import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_FORMAT_VERSION, collectEmbeddedAssets } from "../src/assets.ts";
import { BuildConfigError } from "../src/build-config.ts";
import type { EmbedDeclaration } from "../src/compiler/frontend/embed-declarations.ts";
import { FrontendCompilationSession } from "../src/frontend-cache.ts";

function fixture(): string {
	const root = mkdtempSync(path.join(tmpdir(), "mal-assets-unit-"));
	mkdirSync(path.join(root, "tree", "nested"), { recursive: true });
	mkdirSync(path.join(root, "tree", ".config"), { recursive: true });
	writeFileSync(path.join(root, "tree", "root.txt"), "root\n");
	writeFileSync(path.join(root, "tree", "Zebra.txt"), "zebra\n");
	writeFileSync(path.join(root, "tree", ".env"), "SECRET=1\n");
	writeFileSync(path.join(root, "tree", ".config", "app.txt"), "config\n");
	writeFileSync(path.join(root, "tree", "nested", "child.txt"), "child\n");
	writeFileSync(path.join(root, "tree", "nested", "ignored.bin"), new Uint8Array([0, 1]));
	writeFileSync(path.join(root, "empty.bin"), "");
	return root;
}

function directory(root: string, options: Omit<EmbedDeclaration, "kind" | "path"> = {}) {
	return { kind: "directory" as const, path: path.join(root, "tree"), ...options };
}

function paths(declaration: EmbedDeclaration): Array<string> {
	return collectEmbeddedAssets([declaration])[0]!.files.map((file) => file.path);
}

describe("embedded asset collection", () => {
	it("lists member files in code point order, without dotfiles by default", () => {
		const root = fixture();
		expect(paths(directory(root))).toEqual([
			"Zebra.txt",
			"nested/child.txt",
			"nested/ignored.bin",
			"root.txt",
		]);
		expect(paths(directory(root, { dot: true }))).toEqual([
			".config/app.txt",
			".env",
			"Zebra.txt",
			"nested/child.txt",
			"nested/ignored.bin",
			"root.txt",
		]);
	});

	it("filters members by include and exclude patterns", () => {
		const root = fixture();
		expect(paths(directory(root, { include: ["**/*.txt"], exclude: ["Z*"] }))).toEqual([
			"nested/child.txt",
			"root.txt",
		]);
		expect(paths(directory(root, { include: [".config/*.txt"] }))).toEqual([
			".config/app.txt",
		]);
	});

	it("fails when an include pattern matches no files", () => {
		const root = fixture();
		expect(() =>
			collectEmbeddedAssets([directory(root, { include: ["missing/**"] })]),
		).toThrow(BuildConfigError);
	});

	it("fails for a declared path that is missing or of the wrong kind", () => {
		const root = fixture();
		expect(() =>
			collectEmbeddedAssets([{ kind: "file", path: path.join(root, "missing.txt") }]),
		).toThrow(/missing\.txt': cannot read/);
		expect(() =>
			collectEmbeddedAssets([{ kind: "file", path: path.join(root, "tree") }]),
		).toThrow(/not a regular file/);
		expect(() =>
			collectEmbeddedAssets([{ kind: "directory", path: path.join(root, "empty.bin") }]),
		).toThrow(/not a directory/);
	});

	it.skipIf(process.platform === "win32")(
		"rejects a symbolic link it would embed",
		() => {
			const root = fixture();
			symlinkSync(path.join(root, "empty.bin"), path.join(root, "tree", "linked.txt"));
			expect(() => collectEmbeddedAssets([directory(root)])).toThrow(
				"'linked.txt' is not a regular file",
			);
			expect(paths(directory(root, { exclude: ["linked.txt"] }))).not.toContain(
				"linked.txt",
			);
		},
	);

	it("names an asset by its declaration and identifies it by its contents", () => {
		const root = fixture();
		const declaration = directory(root, { include: ["**/*.txt"] });
		const [asset] = collectEmbeddedAssets([declaration]);
		expect(asset?.name).toBe(JSON.stringify(declaration));
		expect(asset?.version).toBe(ASSET_FORMAT_VERSION);
		expect(collectEmbeddedAssets([declaration])[0]?.hash).toBe(asset?.hash);
		writeFileSync(path.join(root, "tree", "root.txt"), "changed\n");
		expect(collectEmbeddedAssets([declaration])[0]?.hash).not.toBe(asset?.hash);
	});

	it("snapshots the exact bytes it recorded", () => {
		const root = fixture();
		const [asset] = collectEmbeddedAssets([
			{ kind: "file", path: path.join(root, "empty.bin") },
		]);
		const file = asset!.files[0]!;
		writeFileSync(path.join(root, "empty.bin"), "changed after collection");
		expect(readFileSync(file.sourcePath)).toEqual(Buffer.from([]));
		expect(file).toMatchObject({ path: "empty.bin", size: 0 });
	});

	it("reuses and repairs content-addressed snapshots", () => {
		const root = fixture();
		const cacheDirectory = path.join(root, "cache");
		const declaration = { kind: "file" as const, path: path.join(root, "tree/root.txt") };
		const collect = () => {
			const session = new FrontendCompilationSession();
			session.useCacheDirectory(cacheDirectory);
			const file = collectEmbeddedAssets([declaration], { cacheDirectory, session })[0]!
				.files[0]!;
			session.flush();
			return { file, session };
		};
		const cold = collect().file;
		const warm = collect();
		expect(warm.file.sourcePath).toBe(cold.sourcePath);
		expect(warm.session.digestStatistics()).toEqual({ hits: 1, misses: 0 });

		writeFileSync(warm.file.sourcePath, "xxxxx");
		expect(readFileSync(collect().file.sourcePath, "utf-8")).toBe("root\n");
	});
});
