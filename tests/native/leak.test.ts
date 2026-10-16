import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-leak-"));
const auditEnabled = os.platform() === "darwin" && process.env.MAL_LEAKCHECK === "1";
const auditTimeoutMs = 300_000;
const fixtures = [
	{ name: "leakaudit", fixture: "tests/local/leakaudit.js" },
	{ name: "leakmodule", fixture: "tests/local/leakmodule.mjs" },
	{
		name: "leakargon2",
		fixture: "tests/local/leakargon2.mjs",
		nodeEnabled: true,
		mainFile: HOST_MAIN,
	},
];
const binaries = new Map<
	string,
	ReturnType<typeof buildBackendPairFromOneProgramImage>
>();

beforeAll(() => {
	for (const fixture of fixtures) {
		process.stderr.write(`[leak-audit] preparing ${fixture.name}\n`);
		binaries.set(
			fixture.name,
			buildBackendPairFromOneProgramImage({
				...fixture,
				name: `leakcheck-${fixture.name}`,
				outDir,
			}),
		);
	}
}, 1_200_000);

afterAll(() => {
	rmSync(outDir, { recursive: true, force: true });
});

function parseLeaks(output: string): { leaks: number; bytes: number } {
	const match = output.match(/(\d+) leaks for (\d+) total leaked bytes/);
	if (!match) throw new Error(`could not parse leaks output:\n${output.slice(0, 4000)}`);
	return { leaks: Number(match[1]), bytes: Number(match[2]) };
}

function auditLeaks(binary: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("leaks", ["--groupByType", "--atExit", "--", binary], {
			env: { ...process.env, MAL_GC_AT_EXIT: "1" },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let failure: Error | undefined;
		function abort(message: string): void {
			if (failure !== undefined) return;
			failure = new Error(message);
			const sample = spawnSync(
				"/usr/bin/sample",
				[path.basename(binary), "1", "-mayDie", "-file", "/dev/stdout"],
				{ encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
			);
			process.stderr.write(
				`[leak-audit] stalled process sample: ${binary}\n${sample.stdout ?? ""}\n${sample.stderr ?? ""}\n`,
			);
			if (child.pid !== undefined) {
				try {
					// The tool launches the audited process; terminate both on failure.
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		}
		const timer = setTimeout(
			() => abort(`leaks timed out after ${auditTimeoutMs}ms: ${binary}`),
			auditTimeoutMs,
		);
		child.stdout.setEncoding("utf8").on("data", (data: string) => {
			stdout += data;
			if (stdout.length > 64 * 1024 * 1024) abort("leaks stdout exceeded 64 MiB");
		});
		child.stderr.setEncoding("utf8").on("data", (data: string) => {
			stderr += data;
			if (stderr.length > 64 * 1024 * 1024) abort("leaks stderr exceeded 64 MiB");
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (failure !== undefined || signal !== null || code !== 0) {
				reject(
					new Error(
						`${failure?.message ?? `leaks exited ${code} (${signal})`}:\n${stdout.slice(-8000)}\n${stderr.slice(-8000)}`,
					),
				);
			} else resolve(stdout);
		});
	});
}

describe("leak fixture shutdown", () => {
	for (const fixture of fixtures) {
		it(
			`preserves output and exits after finalizing ${fixture.name} in both backends`,
			() => {
				const expected = execFileSync(process.execPath, [fixture.fixture], {
					encoding: "utf8",
					timeout: 30_000,
				});
				const pair = binaries.get(fixture.name)!;
				for (const [backend, binary] of Object.entries({
					compiled: pair.compiled,
					interpreted: pair.interpreted,
				})) {
					process.stderr.write(`[leak-audit] shutdown ${fixture.name} ${backend}\n`);
					expect(
						runToStdout(binary, {
							env: { MAL_GC_AT_EXIT: "1" },
							timeoutMs: 30_000,
						}),
					).toBe(expected);
				}
			},
			2 * scaledNativeRunTimeoutMs(30_000) + 30_000,
		);
	}
});

describe.skipIf(!auditEnabled)("GC leak audit (macOS `leaks`)", () => {
	for (const fixture of fixtures) {
		it(
			`leaks zero bytes after finalizing ${fixture.name}`,
			async () => {
				process.stderr.write(`[leak-audit] leaks ${fixture.name}\n`);
				const output = await auditLeaks(binaries.get(fixture.name)!.compiled);
				const result = parseLeaks(output);
				expect(result, output).toEqual({ leaks: 0, bytes: 0 });
			},
			auditTimeoutMs + 20_000,
		);
	}
});
