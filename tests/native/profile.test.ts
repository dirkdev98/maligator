import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCompilerCapture, parseProfileCapture } from "../../src/profile-artifact.ts";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-profile-"));

describe("production profile recorder", () => {
	let binary: string;
	let deepStackBinary: string;
	let longRunningBinary: string;
	let compilerBinary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/profile.js",
			name: "profile-recorder",
			compiled: true,
			profileEnabled: true,
			outDir: directory,
		});
		deepStackBinary = buildNativeBinary({
			fixture: "tests/local/profile-deep-stack.js",
			name: "profile-deep-stack",
			compiled: true,
			profileEnabled: true,
			outDir: directory,
		});
		longRunningBinary = buildNativeBinary({
			fixture: "tests/local/profile-long-running.js",
			name: "profile-long-running",
			compiled: true,
			profileEnabled: true,
			mainFile: HOST_MAIN,
			outDir: directory,
		});
		compilerBinary = buildNativeBinary({
			fixture: "tests/local/profile.js",
			name: "profile-compiler-counters",
			compiled: true,
			profileEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			outDir: directory,
		});
	});

	it("captures bounded logical CPU stacks in the versioned raw format", () => {
		const capture = path.join(directory, "capture.bin");
		const result = spawnSync(binary, [], {
			env: { ...process.env, MAL_PROFILE_CAPTURE: capture },
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(existsSync(capture)).toBe(true);
		const bytes = readFileSync(capture);
		expect(bytes.subarray(0, 8).toString()).toBe("MALPROF3");
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		expect(view.getUint32(8, true)).toBe(3);
		const recordCount = view.getUint32(12, true);
		const frameCount = view.getUint32(16, true);
		expect(recordCount).toBeGreaterThan(0);
		expect(frameCount).toBeGreaterThan(0);
		expect(view.getBigUint64(40, true)).toBe(524_288n);
		expect(view.getUint8(48)).toBe(1);
		expect(bytes.byteLength).toBe(48 + recordCount * 40 + frameCount * 12);
	});

	it("accounts for every omitted frame in a deep logical stack", () => {
		const capture = path.join(directory, "deep-stack.bin");
		const result = spawnSync(deepStackBinary, [], {
			env: { ...process.env, MAL_PROFILE_CAPTURE: capture },
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		const parsed = parseProfileCapture(readFileSync(capture));
		const truncated = parsed.records.find(
			(record) => record.depthTruncated && record.omittedFrames > 0,
		);
		expect(parsed.droppedFrames).toBeGreaterThan(0);
		expect(truncated).toBeDefined();
		expect(truncated?.frames).toHaveLength(128);
		expect(truncated?.frames.at(-1)?.siteId).toBeGreaterThanOrEqual(0);
	});

	it("flushes a valid capture before a development-style termination", async () => {
		const capture = path.join(directory, "terminated.bin");
		const child = spawn(longRunningBinary, [], {
			env: { ...process.env, MAL_PROFILE_CAPTURE: capture },
			stdio: "ignore",
		});
		const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (_code, exitSignal) => resolve(exitSignal));
		});
		// Native startup initializes the full runtime before the recorder is armed.
		await new Promise((resolve) => {
			setTimeout(resolve, 750);
		});
		child.kill("SIGTERM");
		const signal = await exited;
		expect(signal).toBe("SIGTERM");
		expect(readFileSync(capture).subarray(0, 8).toString()).toBe("MALPROF3");
	});

	it("publishes exact source-site compiler counters in a separate artifact", () => {
		const capture = path.join(directory, "compiler.bin");
		const result = spawnSync(compilerBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_COMPILER: "1",
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		const compiler = parseCompilerCapture(readFileSync(`${capture}.compiler`));
		expect(compiler.totalSiteCount).toBeGreaterThan(0);
		expect(compiler.bySite.some((events) => events.executions > 0)).toBe(true);
		expect(compiler.bySite.some((events) => events.safepoints > 0)).toBe(true);
		expect(compiler.allocations.some((entry) => entry.chargedBytes > 0)).toBe(true);
	});
});
