import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export function writeFileAtomically(
	destination: string,
	contents: string | Uint8Array,
): void {
	const directory = path.dirname(destination);
	mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `.publish-${process.pid}-${randomUUID()}`);
	try {
		writeFileSync(temporary, contents, { flag: "wx" });
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}
