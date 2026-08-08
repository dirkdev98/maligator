import { hash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	hashDirectoryTrees,
	hashDirectoryTreesCached,
	legacyLocaleNameComparator,
	walkDirectoryTree,
} from "../src/file-tree.ts";

function framedFile(relativePath: string, contents: string): Array<string> {
	return [relativePath, "\0", hash("sha256", Buffer.from(contents), "hex"), "\0"];
}

describe("deterministic file trees", () => {
	it("preserves depth-first ordering and NUL-framed tree hashes", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-file-tree-"));
		mkdirSync(path.join(root, "first", "nested"), { recursive: true });
		mkdirSync(path.join(root, "second"));
		writeFileSync(path.join(root, "first", "z.rs"), "z\n");
		writeFileSync(path.join(root, "first", "nested", "a.rs"), "a\n");
		writeFileSync(path.join(root, "first", "ignored.txt"), "ignored\n");
		writeFileSync(path.join(root, "second", "last.rs"), "last\n");

		const prefix = ["schema\0"];
		const expected = hash(
			"sha256",
			[
				...prefix,
				...framedFile(path.join("first", "nested", "a.rs"), "a\n"),
				...framedFile(path.join("first", "z.rs"), "z\n"),
				...framedFile(path.join("second", "last.rs"), "last\n"),
			].join(""),
			"hex",
		);

		expect(
			hashDirectoryTrees({
				root,
				directories: [path.join(root, "first"), path.join(root, "second")],
				include: (entry) => entry.name.endsWith(".rs"),
				prefix,
			}),
		).toBe(expected);
	});

	it("uses deterministic lexical ordering by default", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-file-tree-order-"));
		writeFileSync(path.join(root, "!.ts"), "first\n");
		writeFileSync(path.join(root, ",.ts"), "second\n");
		const visited: Array<string> = [];

		walkDirectoryTree(root, ({ dirent }) => visited.push(dirent.name));

		expect(visited).toEqual(["!.ts", ",.ts"]);
	});

	it("can prune generated directory subtrees", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-file-tree-prune-"));
		mkdirSync(path.join(root, "target"));
		writeFileSync(path.join(root, "source.rs"), "source\n");
		writeFileSync(path.join(root, "target", "generated.rs"), "generated\n");

		const digest = hashDirectoryTrees({
			root,
			directories: [root],
			include: (entry) => entry.name.endsWith(".rs"),
			descend: (entry) => entry.dirent.name !== "target",
		});

		expect(digest).toBe(
			hash("sha256", framedFile("source.rs", "source\n").join(""), "hex"),
		);
	});

	it("reuses persistent file digests and invalidates metadata-preserving edits", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-file-tree-cache-"));
		const source = path.join(root, "source.rs");
		const manifest = path.join(root, "cache", "digests.json");
		writeFileSync(source, "first\n");
		const options = {
			root,
			directories: [root],
			include: (entry: { name: string }) => entry.name.endsWith(".rs"),
		};

		const first = hashDirectoryTreesCached(options, manifest, "test-v1");
		expect(first).toMatchObject({ reusedFiles: 0, hashedFiles: 1 });
		expect(first.digest).toBe(hashDirectoryTrees(options));
		const manifestMtime = statSync(manifest).mtimeMs;

		const second = hashDirectoryTreesCached(options, manifest, "test-v1");
		expect(second).toEqual({ digest: first.digest, reusedFiles: 1, hashedFiles: 0 });
		expect(statSync(manifest).mtimeMs).toBe(manifestMtime);

		const originalTimes = statSync(source);
		writeFileSync(source, "other\n");
		utimesSync(source, originalTimes.atime, originalTimes.mtime);
		const changed = hashDirectoryTreesCached(options, manifest, "test-v1");
		expect(changed).toMatchObject({ reusedFiles: 0, hashedFiles: 1 });
		expect(changed.digest).not.toBe(first.digest);
		expect(JSON.parse(readFileSync(manifest, "utf-8"))).toMatchObject({
			schema: 1,
			identity: "test-v1",
			root,
		});
	});

	it("keeps old locale cross-name order with deterministic lexical ties", () => {
		const names = ["!.ts", ",.ts"];
		const localeOrder = names[0]!.localeCompare(names[1]!);
		expect(localeOrder).not.toBe(0);
		expect(Math.sign(legacyLocaleNameComparator(names[0]!, names[1]!))).toBe(
			Math.sign(localeOrder),
		);

		const composed = "\u00e9.ts";
		const decomposed = "e\u0301.ts";
		expect(composed.localeCompare(decomposed)).toBe(0);
		expect([composed, decomposed].sort(legacyLocaleNameComparator)).toEqual([
			decomposed,
			composed,
		]);
	});

	it.skipIf(process.platform === "win32")(
		"continues to hash matching symlinks as non-directory entries",
		() => {
			const root = mkdtempSync(path.join(tmpdir(), "mal-file-tree-link-"));
			const target = path.join(path.dirname(root), `${path.basename(root)}-target`);
			writeFileSync(target, "linked\n");
			symlinkSync(target, path.join(root, "linked.rs"));

			const expected = hash(
				"sha256",
				framedFile("linked.rs", "linked\n").join(""),
				"hex",
			);
			expect(
				hashDirectoryTrees({
					root,
					directories: [root],
					include: (entry) => entry.name.endsWith(".rs"),
				}),
			).toBe(expected);
		},
	);
});
