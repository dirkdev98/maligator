import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { beforeAll, describe, expect, it } from "vitest";
import { HOST_MODULES } from "../../src/compiler/frontend/host-modules.ts";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";

async function retainedHostInstallers(binary: string): Promise<Array<string>> {
	const child = spawn("nm", ["-g", binary], { stdio: ["ignore", "pipe", "pipe"] });
	const symbols: Array<string> = [];
	let stderr = "";
	child.stderr.setEncoding("utf-8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-8192);
	});
	const completion = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`nm failed (${signal ?? code}): ${stderr}`));
		});
	});
	await Promise.all([
		completion,
		(async () => {
			for await (const line of createInterface({
				input: child.stdout,
				crlfDelay: Infinity,
			})) {
				if (!/\sT\s/.test(line)) continue;
				const raw = line.trim().split(/\s+/).at(-1) ?? "";
				const symbol = raw.startsWith("_") ? raw.slice(1) : raw;
				if (symbol.startsWith("mal_host_install_")) symbols.push(symbol);
			}
		})(),
	]);
	return symbols.sort();
}

// The host main always links the application API and the worker runtime it shuts down,
// so their installers' objects are present whatever the program imports.
const HOST_MAIN_INSTALLERS = [
	"mal_host_install_maligator",
	"mal_host_install_maligator_internal_workers",
];

describe("node host installer link retention", () => {
	let pathInstallers: Array<string>;
	let processInstallers: Array<string>;
	let deadPathInstallers: Array<string>;
	let bufferInstallers: Array<string>;
	let deadBufferInstallers: Array<string>;

	async function installers(fixture: string, name: string): Promise<Array<string>> {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-link-retention-"));
		try {
			return await retainedHostInstallers(
				buildNativeBinary({
					fixture,
					name,
					mainFile: HOST_MAIN,
					outDir,
					nodeEnabled: true,
				}),
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}

	beforeAll(async () => {
		pathInstallers = await installers("tests/local/node-link-path.mjs", "node-link-path");
		processInstallers = await installers(
			"tests/local/node-link-process.mjs",
			"node-link-process",
		);
		deadPathInstallers = await installers(
			"tests/local/node-link-dead-path.mjs",
			"node-link-dead-path",
		);
		bufferInstallers = await installers(
			"tests/local/node-link-buffer.mjs",
			"node-link-buffer",
		);
		deadBufferInstallers = await installers(
			"tests/local/node-link-dead-buffer.mjs",
			"node-link-dead-buffer",
		);
	}, 1_200_000);

	it("retains only the path installer object for a path-only program", () => {
		expect(pathInstallers).toEqual([
			...HOST_MAIN_INSTALLERS,
			"mal_host_install_node_path",
			// All path installers belong to the same runtime archive member.
			"mal_host_install_node_path_posix",
			"mal_host_install_node_path_win32",
		]);
	});

	it("retains dynamic builtin installers when process.getBuiltinModule is available", () => {
		expect(processInstallers).toEqual(
			[
				...new Set([
					...HOST_MAIN_INSTALLERS,
					...[...HOST_MODULES.values()].map((module) => module.installer),
				]),
			].sort(),
		);
	});

	it("omits the path installer when its only read is optimized away", () => {
		expect(deadPathInstallers).toEqual(HOST_MAIN_INSTALLERS);
	});

	it("retains Buffer for a reachable free global", () => {
		expect(bufferInstallers).toEqual([
			...HOST_MAIN_INSTALLERS,
			"mal_host_install_node_buffer",
		]);
	});

	it("omits the Buffer installer when its imported read is optimized away", () => {
		expect(deadBufferInstallers).toEqual(HOST_MAIN_INSTALLERS);
	});
});
