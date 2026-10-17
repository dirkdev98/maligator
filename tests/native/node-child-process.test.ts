import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, statfsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-child-process-"));
const fixture = "tests/local/node-child-process.mts";

describe("node:child_process execFileSync (POSIX)", () => {
	// This fixture reports through stdout, so closing 0/1/2 in the launched test
	// process would also remove the harness result channel. The host implementation
	// documents and enforces the testable invariant instead: every pipe endpoint is
	// moved above fd 2 before any child-side dup2 sequence begins.
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "node-child-process-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "node-child-process-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled, { timeoutMs: 30000 }));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted, { timeoutMs: 30000 }));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 30000 }));
	});
});

describe("node:child_process detached spawn and unref", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/node-child-process-unref.mts",
			name: "node-child-process-unref",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("exits without waiting for an unreferenced child that outlives its process group", async () => {
		const marker = path.join(outDir, "detached-child-finished");
		const started = Date.now();
		const program = spawn(binary, [marker, "3000"], {
			cwd: outDir,
			detached: true,
			stdio: ["ignore", "pipe", "inherit"],
		});
		let stdout = "";
		program.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		const status = await new Promise<number | null>((resolve) => {
			program.once("close", resolve);
		});
		const elapsed = Date.now() - started;
		try {
			process.kill(-program.pid!, "SIGKILL");
		} catch {
			// Nothing else was left in the program's process group.
		}

		expect(status).toBe(0);
		expect(elapsed).toBeLessThan(2500);
		const reported = JSON.parse(stdout) as {
			pid: number;
			bsize: number;
			blocks: number;
			files: number;
		};
		const volume = statfsSync(outDir);
		// APFS derives its inode total from free space, so only the geometry is stable.
		expect(reported).toMatchObject({ bsize: volume.bsize, blocks: volume.blocks });
		expect(reported.files).toBeGreaterThan(0);
		expect(reported.pid).toBeGreaterThan(0);
		const deadline = Date.now() + 10_000;
		while (!existsSync(marker) && Date.now() < deadline) await sleep(100);
		expect(existsSync(marker)).toBe(true);
	}, 30_000);
});
