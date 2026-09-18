import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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

async function eventuallyExists(file: string): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (existsSync(file)) return true;
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

	it("forwards supervisor termination and does not orphan its process group", async () => {
		if (process.platform === "win32") return;
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-perf-interrupt-"));
		const worker = path.join(directory, "worker.mjs");
		const supervisor = path.join(directory, "supervisor.mjs");
		const pidFile = path.join(directory, "descendant.pid");
		writeFileSync(
			worker,
			`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
		);
		writeFileSync(
			supervisor,
			`import { runBoundedProcess } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../scripts/performance-process.ts")).href)};
await runBoundedProcess(process.execPath, [${JSON.stringify(worker)}], { environment: process.env, timeoutMs: 30000 }).catch(() => { process.exitCode = 143; });
`,
		);
		const processUnderTest = spawn(process.execPath, [supervisor], { stdio: "ignore" });
		try {
			expect(await eventuallyExists(pidFile)).toBe(true);
			const descendant = Number(readFileSync(pidFile, "utf8"));
			processUnderTest.kill("SIGTERM");
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("supervisor did not exit")),
					5_000,
				);
				processUnderTest.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			expect(await eventuallyStopped(descendant)).toBe(true);
		} finally {
			if (processUnderTest.exitCode === null) processUnderTest.kill("SIGKILL");
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
