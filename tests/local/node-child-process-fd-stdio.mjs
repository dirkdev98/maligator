import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.MAL_FD_STDIO_CASE;
const asynchronous = mode === "async" || mode === "crossed-async";
const node = process.env.MAL_FD_CHILD_NODE || process.execPath;
const script =
	'const fs = require("node:fs"); const input = fs.readFileSync(0, "utf8"); fs.writeSync(1, input + "stdout"); fs.writeSync(2, "stderr");';

async function launch(stdio) {
	if (!asynchronous) {
		const result = spawnSync(node, ["-e", script], { stdio });
		return [
			result.status,
			result.signal,
			result.stdout,
			result.stderr,
			result.error?.code,
		];
	}
	const child = spawn(node, ["-e", script], { stdio });
	let error;
	child.on("error", (value) => {
		error = value.code;
	});
	const result = await new Promise((resolve) => {
		child.on("close", (code, signal) => resolve([code, signal]));
	});
	return [...result, child.stdout, child.stderr, error];
}

if (mode === "crossed-sync" || mode === "crossed-async") {
	const result = await launch(["ignore", 2, 1]);
	if (result[0] !== 0 || result[1] !== null || result[4] !== undefined)
		throw new Error(JSON.stringify(result));
} else {
	const directory = mkdtempSync(join(tmpdir(), "mal-fd-stdio-"));
	const descriptors = [];
	try {
		const input = join(directory, "input");
		const output = join(directory, "output");
		const errors = join(directory, "errors");
		writeFileSync(input, "input:");
		descriptors.push(openSync(input, "r"), openSync(output, "w"), openSync(errors, "w"));
		const fds =
			mode === "fractional" ? descriptors.map((fd) => fd + 0.5) : [...descriptors];
		if (mode === "shared") fds[2] = fds[1];
		if (mode === "closed") closeSync(descriptors.pop());
		const result = await launch(fds);
		if (mode === "closed") {
			console.log(JSON.stringify(result));
		} else {
			writeSync(descriptors[1], ":parent");
			writeSync(descriptors[2], ":parent");
			console.log(
				JSON.stringify([
					result,
					readFileSync(output, "utf8"),
					readFileSync(errors, "utf8"),
				]),
			);
		}
	} finally {
		for (const descriptor of descriptors) closeSync(descriptor);
		rmSync(directory, { recursive: true, force: true });
	}
}
