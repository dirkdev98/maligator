import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it("drains a cancelled native compiler action before releasing its lock and accepting the next build", async () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-compiler-cancellation-"));
	const child = spawn(
		process.execPath,
		[path.resolve("tests/fixtures/compiler-service/cancel-native.mts"), directory],
		{
			cwd: directory,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const kill = () => {
		if (child.pid === undefined) return;
		try {
			if (process.platform === "win32") child.kill("SIGKILL");
			else process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	const timeout = setTimeout(kill, 180_000);
	try {
		const exit = await new Promise<{ code: number | null; signal: string | null }>(
			(resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolve({ code, signal }));
			},
		);
		expect(exit, stderr || stdout).toEqual({ code: 0, signal: null });
		expect(stdout).toContain("native cancellation drained; next build executed");
	} finally {
		clearTimeout(timeout);
		kill();
		rmSync(directory, { recursive: true, force: true });
	}
}, 200_000);
