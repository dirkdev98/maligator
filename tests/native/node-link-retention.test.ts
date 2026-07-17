import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-link-retention-"));

function retainedHostInstallers(binary: string): Array<string> {
	return execFileSync("nm", ["-g", binary], { encoding: "utf-8" })
		.split("\n")
		.map((line) => line.trim().split(/\s+/).at(-1) ?? "")
		.map((symbol) => (symbol.startsWith("_") ? symbol.slice(1) : symbol))
		.filter((symbol) => symbol.startsWith("mal_host_install_"))
		.sort();
}

describe("node host installer link retention", () => {
	let pathOnly: string;
	let processOnly: string;
	let deadPath: string;
	let bufferOnly: string;
	let deadBuffer: string;

	beforeAll(() => {
		pathOnly = buildNativeBinary({
			fixture: "tests/local/node-link-path.mjs",
			name: "node-link-path",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		processOnly = buildNativeBinary({
			fixture: "tests/local/node-link-process.mjs",
			name: "node-link-process",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		deadPath = buildNativeBinary({
			fixture: "tests/local/node-link-dead-path.mjs",
			name: "node-link-dead-path",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		bufferOnly = buildNativeBinary({
			fixture: "tests/local/node-link-buffer.mjs",
			name: "node-link-buffer",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		deadBuffer = buildNativeBinary({
			fixture: "tests/local/node-link-dead-buffer.mjs",
			name: "node-link-dead-buffer",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("retains only the node:path installer for a path-only program", () => {
		expect(retainedHostInstallers(pathOnly)).toEqual([
			"mal_host_install_maligator",
			"mal_host_install_node_path",
		]);
	});

	it("retains only the process installer for a process-only program", () => {
		expect(retainedHostInstallers(processOnly)).toEqual([
			"mal_host_install_maligator",
			"mal_host_install_process",
		]);
	});

	it("omits the path installer when its only read is optimized away", () => {
		expect(retainedHostInstallers(deadPath)).toEqual(["mal_host_install_maligator"]);
	});

	it("retains Buffer for a reachable free global", () => {
		expect(retainedHostInstallers(bufferOnly)).toEqual([
			"mal_host_install_maligator",
			"mal_host_install_node_buffer",
		]);
	});

	it("omits the Buffer installer when its imported read is optimized away", () => {
		expect(retainedHostInstallers(deadBuffer)).toEqual(["mal_host_install_maligator"]);
	});
});
