import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ASSET_FORMAT_VERSION, includeConfiguredAssets } from "../src/assets.ts";
import { BuildConfigError } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compile-program.ts";
import { emitVmDefinition } from "../src/emit-vm.ts";

function fixture(): string {
	const root = mkdtempSync(path.join(tmpdir(), "mal-assets-unit-"));
	mkdirSync(path.join(root, "tree", "nested"), { recursive: true });
	writeFileSync(path.join(root, "tree", "root.txt"), "root\n");
	writeFileSync(path.join(root, "tree", "nested", "child.txt"), "child\n");
	writeFileSync(path.join(root, "tree", "nested", "ignored.bin"), new Uint8Array([0, 1]));
	writeFileSync(path.join(root, "empty.bin"), "");
	return root;
}

describe("configured asset inclusion", () => {
	it("collects a deterministic filtered directory manifest", () => {
		const root = fixture();
		const [asset] = includeConfiguredAssets(
			{
				docs: {
					type: "directory",
					path: "tree",
					include: ["*.txt", "nested/**/*.txt"],
				},
			},
			root,
		);

		expect(asset?.version).toBe(ASSET_FORMAT_VERSION);
		expect(asset?.files.map((file) => file.path)).toEqual([
			"nested/child.txt",
			"root.txt",
		]);
		expect(asset?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(
			includeConfiguredAssets(
				{
					docs: {
						type: "directory",
						path: "tree",
						include: ["*.txt", "nested/**/*.txt"],
					},
				},
				root,
			)[0]?.hash,
		).toBe(asset?.hash);
	});

	it("includes an empty file with its materialized basename", () => {
		const root = fixture();
		const [asset] = includeConfiguredAssets(
			{ empty: { type: "file", path: "empty.bin" } },
			root,
		);
		expect(asset?.files).toEqual([
			expect.objectContaining({ path: "empty.bin", size: 0 }),
		]);
	});

	it("changes the content hash when a file changes", () => {
		const root = fixture();
		const config = {
			docs: { type: "directory" as const, path: "tree", include: ["**/*.txt"] },
		};
		const before = includeConfiguredAssets(config, root)[0]?.hash;
		writeFileSync(path.join(root, "tree", "root.txt"), "changed\n");
		expect(includeConfiguredAssets(config, root)[0]?.hash).not.toBe(before);
	});

	it("snapshots the exact bytes used for the inclusion hash", () => {
		const root = fixture();
		const [asset] = includeConfiguredAssets(
			{ data: { type: "file", path: "empty.bin" } },
			root,
		);
		const snapshot = asset!.files[0]!.sourcePath;
		writeFileSync(path.join(root, "empty.bin"), "changed after inclusion");
		expect(readFileSync(snapshot)).toEqual(Buffer.from([]));
		expect(asset!.files[0]!.size).toBe(0);
	});

	it("fails when an include pattern matches no files", () => {
		const root = fixture();
		expect(() =>
			includeConfiguredAssets(
				{ docs: { type: "directory", path: "tree", include: ["missing/**"] } },
				root,
			),
		).toThrow(BuildConfigError);
	});

	it("emits C23 payloads, manifest rows, and the mal installer", () => {
		const root = fixture();
		const entry = path.join(root, "main.js");
		writeFileSync(entry, "globalThis.result = 1;\n");
		const assets = includeConfiguredAssets(
			{ empty: { type: "file", path: "empty.bin" } },
			root,
		);
		const output = emitVmDefinition(compileEntrypoint(entry), {
			assets,
			compiled: false,
			maligatorSurface: true,
		});
		expect(output).toContain("static const MalAsset mal_assets[]");
		expect(output).toContain(`.hash = "${assets[0]?.hash}"`);
		expect(output).toContain(".asset_count = 1");
		expect(output).toContain(".installer = mal_host_install_maligator");
		expect(output).toContain("static const u8 mal_asset_0_file_0_data[] = { 0 };");
	});
});
