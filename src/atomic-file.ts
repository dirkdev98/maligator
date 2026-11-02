import { randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { writeSourceChunks } from "./generated-source.ts";

export function writeFileAtomically(
	destination: string,
	contents: string | Uint8Array | Iterable<string>,
): void {
	const directory = path.dirname(destination);
	mkdirSync(directory, { recursive: true });
	const temporary = path.join(directory, `.publish-${process.pid}-${randomUUID()}`);
	try {
		if (typeof contents === "string" || contents instanceof Uint8Array)
			writeFileSync(temporary, contents, { flag: "wx" });
		else {
			const descriptor = openSync(temporary, "wx");
			try {
				writeSourceChunks(descriptor, contents);
			} finally {
				closeSync(descriptor);
			}
		}
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
}
