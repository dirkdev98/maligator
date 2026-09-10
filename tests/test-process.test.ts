import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, onTestFinished, test } from "vitest";

interface ScratchReport {
	root: string;
	nested: string;
	descendant?: number;
	tmp: string;
	temp: string;
}

function start(mode: string, keep = false) {
	const parent = mkdtempSync(join(tmpdir(), "mal-test-process-check-"));
	const sibling = join(parent, "unrelated.txt");
	writeFileSync(sibling, "preserve");
	const child = spawn(
		process.execPath,
		[
			resolve("tests/fixtures/test-process/runner.mts"),
			mode,
			...(keep ? ["--keep-artifacts"] : []),
		],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent },
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
	const done = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	onTestFinished(async () => {
		try {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			await done;
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
	return {
		child,
		parent,
		done,
		output: () => ({ stdout, stderr }),
		report: () => JSON.parse(stdout.split("\n")[0]!) as ScratchReport,
		assertClean: () => {
			expect(readdirSync(parent)).toEqual(["unrelated.txt"]);
			expect(readFileSync(sibling, "utf8")).toBe("preserve");
		},
	};
}

test.each([
	["success", 0],
	["failure", 7],
] as const)(
	"cleans nested test scratch after %s without changing the exit code",
	async (mode, code) => {
		const run = start(mode);
		expect(await run.done).toBe(code);
		const report = run.report();
		expect(report.root).toBe(report.tmp);
		expect(report.root).toBe(report.temp);
		expect(existsSync(report.nested)).toBe(false);
		run.assertClean();
	},
);

test("removes scratch when the executable cannot start", async () => {
	const run = start("spawn-error");
	expect(await run.done).not.toBe(0);
	expect(run.output().stderr).toContain("ENOENT");
	run.assertClean();
});

test("retains scratch only when explicitly requested and reports its path", async () => {
	const run = start("failure", true);
	expect(await run.done).toBe(7);
	const report = run.report();
	expect(readFileSync(join(report.nested, "generated.c"), "utf8")).toContain("int main");
	expect(run.output().stdout).toContain(`[test-artifacts] retained ${report.root}`);
});

test.skipIf(process.platform === "win32").each([
	["wait", "SIGTERM", 143],
	["wait", "SIGINT", 130],
	["ignore-termination", "SIGTERM", 143],
] as const)(
	"cleans scratch for %s after %s reaches the wrapper",
	async (mode, signal, code) => {
		const run = start(mode);
		await expect.poll(() => run.output().stdout).toContain("fixture-");
		run.child.kill(signal);
		expect(await run.done).toBe(code);
		run.assertClean();
	},
);

test.skipIf(process.platform === "win32")(
	"stops leftover descendants before removing scratch",
	async () => {
		const run = start("descendant");
		expect(await run.done).toBe(0);
		const pid = run.report().descendant!;
		await expect
			.poll(() => {
				try {
					process.kill(pid, 0);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					return false;
				}
			})
			.toBe(false);
		run.assertClean();
	},
);
