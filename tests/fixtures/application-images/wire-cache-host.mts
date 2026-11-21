import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import process from "node:process";
import type { ApplicationImageDescriptor } from "../../../src/application-images.ts";
import type { FixtureBridge } from "./types.ts";

const bridge = Reflect.get(globalThis, "mal") as FixtureBridge;
const { descriptor, replacement } = JSON.parse(
	readFileSync(process.argv[2]!, "utf8"),
) as {
	descriptor: ApplicationImageDescriptor;
	replacement: ApplicationImageDescriptor["wires"][number];
};
const edited = descriptor.wires[1]!;
utimesSync(edited.path, 100, 100);

async function run() {
	const handle = bridge._loadApplicationImage(descriptor);
	try {
		const application = bridge._launchApplicationImage(handle, {
			argv: ["application-host", descriptor.entryPath],
			exitOnResult: true,
		});
		const exit = await application.closed;
		if (exit.reason !== "completed" || typeof exit.result !== "string")
			throw new Error(`application failed: ${JSON.stringify(exit)}`);
		process.stdout.write(`${exit.result}\n`);
	} finally {
		bridge._releaseApplicationImage(handle);
	}
}

await run();
const original = statSync(edited.path);
const modified = readFileSync(replacement.path);
if (modified.length !== original.size)
	throw new Error("wire edit must preserve its size");
writeFileSync(edited.path, modified);
utimesSync(edited.path, 100, 100);

let staleDigestRejected = false;
try {
	bridge._loadApplicationImage(descriptor);
} catch (error) {
	if (!(error instanceof SyntaxError)) throw error;
	staleDigestRejected = true;
}
if (!staleDigestRejected) throw new Error("accepted stale wire digest");

edited.sha256 = replacement.sha256;
await run();
