import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeSourceChunks } from "../../src/generated-source.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-source-bytes-"));
try {
	for (const chunks of [
		["ascii", "\0", "é", "\ud83d", "", "\udc0a", "\ud800", "tail", "\udfff"],
		["x".repeat(256 * 1024 - 1), "\ud83d", "\udc0a", "y".repeat(300 * 1024), "\ud800"],
	]) {
		const file = path.join(directory, "unit.c");
		const digest = createHash("sha256");
		const bytes = writeSourceChunks(file, chunks, digest);
		console.log(
			JSON.stringify({
				bytes,
				written: digest.digest("hex"),
				read: createHash("sha256").update(readFileSync(file)).digest("hex"),
			}),
		);
	}
} finally {
	rmSync(directory, { recursive: true, force: true });
}
