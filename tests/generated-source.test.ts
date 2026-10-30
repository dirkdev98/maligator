import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { writeSourceChunks } from "../src/generated-source.ts";

it.each([
	[],
	["", ""],
	["ascii", "\0", "é", "\ud83d", "", "\udc0a", "\ud800", "tail", "\udfff"],
	["x".repeat(256 * 1024 - 1), "\ud83d", "\udc0a", "y".repeat(300 * 1024), "\ud800"],
	[
		"\u0800".repeat(256 * 1024 - 1),
		"\ud83d",
		"",
		"\udc0a",
		"\u0800".repeat(4),
		"\ud800",
		"\ud800",
		"x",
	],
])("preserves concatenated UTF-8 bytes and digests for fragments %#", (...chunks) => {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-generated-source-"));
	try {
		const file = path.join(directory, "unit.c");
		const expected = Buffer.from(chunks.join(""));
		const digest = createHash("sha256");
		expect(writeSourceChunks(file, chunks, digest)).toBe(expected.length);
		expect(readFileSync(file)).toEqual(expected);
		expect(digest.digest("hex")).toBe(
			createHash("sha256").update(expected).digest("hex"),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
