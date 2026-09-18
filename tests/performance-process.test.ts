import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runBoundedProcess } from "../scripts/performance-process.ts";

async function eventuallyStopped(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		}
		await new Promise((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	return false;
}

describe("bounded performance processes", () => {
	it("kills descendants when a worker exceeds its deadline", async () => {
		if (process.platform === "win32") return;
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-perf-process-"));
		const script = path.join(directory, "hang.mjs");
		const pidFile = path.join(directory, "child.pid");
		writeFileSync(
			script,
			`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
		);
		try {
			await expect(
				runBoundedProcess(process.execPath, [script], {
					environment: process.env,
					timeoutMs: 100,
				}),
			).rejects.toThrow(/timed out/);
			expect(existsSync(pidFile)).toBe(true);
			expect(await eventuallyStopped(Number(readFileSync(pidFile, "utf8")))).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
