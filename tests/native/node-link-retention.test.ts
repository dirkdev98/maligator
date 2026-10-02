import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_MODULES } from "../../src/compiler/frontend/host-modules.ts";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";

function retainedHostInstallers(binary: string): Array<string> {
	return execFileSync("nm", ["-g", binary], { encoding: "utf-8" })
		.split("\n")
		.filter((line) => /\sT\s/.test(line))
		.map((line) => line.trim().split(/\s+/).at(-1) ?? "")
		.map((symbol) => (symbol.startsWith("_") ? symbol.slice(1) : symbol))
		.filter((symbol) => symbol.startsWith("mal_host_install_"))
		.sort();
}

describe("node host installer link retention", () => {
	function installers(fixture: string, name: string): Array<string> {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-link-retention-"));
		try {
			return retainedHostInstallers(
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

	it("retains only the node:path installer for a path-only program", () => {
		expect(installers("tests/local/node-link-path.mjs", "node-link-path")).toEqual([
			"mal_host_install_maligator",
			"mal_host_install_node_path",
		]);
	});

	it("retains dynamic builtin installers when process.getBuiltinModule is available", () => {
		expect(installers("tests/local/node-link-process.mjs", "node-link-process")).toEqual(
			[
				...new Set([
					"mal_host_install_maligator",
					...[...HOST_MODULES.values()].map((module) => module.installer),
				]),
			].sort(),
		);
	});

	it("omits the path installer when its only read is optimized away", () => {
		expect(
			installers("tests/local/node-link-dead-path.mjs", "node-link-dead-path"),
		).toEqual(["mal_host_install_maligator"]);
	});

	it("retains Buffer for a reachable free global", () => {
		expect(installers("tests/local/node-link-buffer.mjs", "node-link-buffer")).toEqual([
			"mal_host_install_maligator",
			"mal_host_install_node_buffer",
		]);
	});

	it("omits the Buffer installer when its imported read is optimized away", () => {
		expect(
			installers("tests/local/node-link-dead-buffer.mjs", "node-link-dead-buffer"),
		).toEqual(["mal_host_install_maligator"]);
	});
});
