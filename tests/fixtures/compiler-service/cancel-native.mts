import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { maligatorCacheDirectory } from "../../../src/cache-root.ts";
import { developmentCompilerInstallation } from "../../../src/cli-commands.ts";
import { parseCliArgs } from "../../../src/cli.ts";
import { createNodeCompilerService } from "../../../src/node-compiler-service.ts";

const root = process.argv[2]!;
const entry = path.join(root, "entry.mts");
writeFileSync(entry, 'console.log("cooperative drain");\n');
const command = parseCliArgs(["build", entry, "--name", `cancellation-${process.pid}`]);
if (command.kind !== "build") throw new Error("expected build command");
const service = createNodeCompilerService(
	developmentCompilerInstallation(path.resolve(import.meta.dirname, "../../../src")),
);
const controller = new AbortController();
let observedLock: string | undefined;
let polling: ReturnType<typeof setInterval> | undefined;
let output: string | undefined;

function ownedLock(directory: string): string | undefined {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			const found = ownedLock(file);
			if (found !== undefined) return found;
		} else if (entry.name === "owner.json") {
			try {
				const owner = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
				if (owner.pid === process.pid) return path.dirname(file);
			} catch {
				// Lock publication and release can race this read-only observation.
			}
		}
	}
	return undefined;
}

try {
	let rejected = false;
	try {
		await service.prepare(command, {
			signal: controller.signal,
			compact: true,
			onPhase(phase) {
				if (phase.label !== "Build native binary" || phase.state !== "started") return;
				polling = setInterval(() => {
					observedLock = ownedLock(path.join(maligatorCacheDirectory(), "locks"));
					if (observedLock === undefined) return;
					clearInterval(polling);
					controller.abort(new Error("cancel while native action owns its lock"));
				}, 2);
			},
		});
	} catch (error) {
		if (error !== controller.signal.reason) throw error;
		rejected = true;
	} finally {
		clearInterval(polling);
	}
	if (!rejected || observedLock === undefined)
		throw new Error("did not cancel an in-flight native action before publication");
	if (
		existsSync(observedLock) ||
		ownedLock(path.join(maligatorCacheDirectory(), "locks"))
	)
		throw new Error("cancelled compilation retained an action lock after drain");
	const next = await service.prepare(command, { compact: true });
	output = next.binaryPath!;
	const executed = spawnSync(next.binaryPath!, [], {
		encoding: "utf8",
		timeout: 10_000,
		killSignal: "SIGKILL",
	});
	if (executed.status !== 0 || executed.stdout !== "cooperative drain\n")
		throw new Error(`subsequent compilation failed: ${executed.stderr}`);
	process.stdout.write("native cancellation drained; next build executed\n");
} finally {
	clearInterval(polling);
	await service.close();
	if (output !== undefined) {
		for (const file of readdirSync(path.dirname(output))) {
			if (file === path.basename(output) || file.startsWith(`${path.basename(output)}.`))
				rmSync(path.join(path.dirname(output), file), { force: true });
		}
	}
}
