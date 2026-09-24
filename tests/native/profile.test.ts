import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCompilerCapture, parseProfileCapture } from "../../src/profile-artifact.ts";
import { buildNativeBinary, HOST_MAIN } from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-profile-"));
const captureIdentity = "b".repeat(64);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("production profile recorder", () => {
	let binary: string;
	let deepStackBinary: string;
	let longRunningBinary: string;
	let compilerBinary: string;
	let phaseBinary: string;
	let runtimeBinary: string;
	let backgroundWorkersBinary: string;
	let dnsWorkersBinary: string;
	let sqliteWorkersBinary: string;

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
		phaseBinary = buildNativeBinary({
			fixture: "tests/local/profile-phases.js",
			name: "profile-phases",
			compiled: true,
			profileEnabled: true,
			outDir: directory,
		});
		runtimeBinary = buildNativeBinary({
			fixture: "tests/local/profile-runtime.mjs",
			name: "profile-runtime-attribution",
			compiled: true,
			profileEnabled: true,
			nodeEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			outDir: directory,
		});
		backgroundWorkersBinary = buildNativeBinary({
			fixture: "tests/local/profile-background-workers.mjs",
			name: "profile-background-workers",
			compiled: true,
			profileEnabled: true,
			nodeEnabled: true,
			mainFile: HOST_MAIN,
			outDir: directory,
		});
		dnsWorkersBinary = buildNativeBinary({
			fixture: "tests/local/profile-dns-workers.mjs",
			name: "profile-dns-workers",
			compiled: true,
			profileEnabled: true,
			nodeEnabled: true,
			mainFile: HOST_MAIN,
			outDir: directory,
		});
		sqliteWorkersBinary = buildNativeBinary({
			fixture: "tests/local/profile-sqlite-workers.mjs",
			name: "profile-sqlite-workers",
			compiled: true,
			profileEnabled: true,
			nodeEnabled: true,
			mainFile: HOST_MAIN,
			outDir: directory,
		});
	});

	it("captures bounded logical CPU stacks in the versioned raw format", () => {
		const capture = path.join(directory, "capture.bin");
		const result = spawnSync(binary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		expect(existsSync(capture)).toBe(true);
		const bytes = readFileSync(capture);
		expect(bytes.subarray(0, 8).toString()).toBe("MALPROF6");
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		expect(view.getUint32(8, true)).toBe(6);
		const recordCount = view.getUint32(12, true);
		const frameCount = view.getUint32(16, true);
		expect(recordCount).toBeGreaterThan(0);
		expect(frameCount).toBeGreaterThan(0);
		expect(view.getBigUint64(40, true)).toBe(524_288n);
		expect(bytes.subarray(48, 80).toString("hex")).toBe(captureIdentity);
		expect(view.getUint32(80, true)).toBe(0);
		expect(view.getUint8(84)).toBe(1);
		expect(bytes.byteLength).toBe(84 + recordCount * 40 + frameCount * 12);
	});

	it("accounts for every omitted frame in a deep logical stack", () => {
		const capture = path.join(directory, "deep-stack.bin");
		const result = spawnSync(deepStackBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		const parsed = parseProfileCapture(readFileSync(capture));
		const truncated = parsed.records.find(
			(record) => record.depthTruncated && record.omittedFrames > 0,
		);
		expect(parsed.droppedFrames).toBeGreaterThan(0);
		expect(truncated).toBeDefined();
		expect(truncated?.frames).toHaveLength(256);
		expect(truncated?.frames.at(-1)?.siteId).toBeGreaterThanOrEqual(0);
	});

	it("marks background CPU workers in the capture metadata", () => {
		const capture = path.join(directory, "background-workers.bin");
		const result = spawnSync(backgroundWorkersBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_IDENTITY: captureIdentity,
				MAL_PROFILE_INTERVAL_US: "1000",
			},
			encoding: "utf8",
		});
		expect(result).toMatchObject({ status: 0, stdout: "done\n", stderr: "" });
		const parsed = parseProfileCapture(readFileSync(capture));
		expect(parsed.workerCpuPossible).toBe(true);
		expect(parsed.records.some((record) => record.kind === 1)).toBe(true);
	});

	it("marks DNS worker captures even when resolution is brief", () => {
		const capture = path.join(directory, "dns-workers.bin");
		const result = spawnSync(dnsWorkersBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			encoding: "utf8",
		});
		expect(result).toMatchObject({ status: 0, stdout: "done\n", stderr: "" });
		const parsed = parseProfileCapture(readFileSync(capture));
		expect(parsed.workerCpuPossible).toBe(true);
	});

	it("marks SQLite sorting captures as possibly containing worker CPU", () => {
		const capture = path.join(directory, "sqlite-workers.bin");
		const result = spawnSync(sqliteWorkersBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			encoding: "utf8",
		});
		expect(result).toMatchObject({ status: 0, stdout: "done\n", stderr: "" });
		const parsed = parseProfileCapture(readFileSync(capture));
		expect(parsed.workerCpuPossible).toBe(true);
	});

	it("flushes a valid capture before a development-style termination", async () => {
		const capture = path.join(directory, "terminated.bin");
		const child = spawn(longRunningBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			stdio: ["ignore", "pipe", "ignore"],
		});
		const exited = new Promise<NodeJS.Signals | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (_code, exitSignal) => resolve(exitSignal));
		});
		const ready = new Promise<void>((resolve, reject) => {
			child.stdout.setEncoding("utf8");
			child.stdout.once("data", (output: string) => {
				if (output.includes("profile-ready")) resolve();
				else reject(new Error(`unexpected profile readiness output: ${output}`));
			});
		});
		await Promise.race([
			ready,
			exited.then(() => {
				throw new Error("profile process exited before readiness");
			}),
		]);
		child.kill("SIGTERM");
		const signal = await exited;
		expect(signal).toBe("SIGTERM");
		expect(readFileSync(capture).subarray(0, 8).toString()).toBe("MALPROF6");
	});

	it("publishes exact source-site compiler counters in a separate artifact", () => {
		const capture = path.join(directory, "compiler.bin");
		const result = spawnSync(compilerBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_COMPILER: "1",
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		const compiler = parseCompilerCapture(readFileSync(`${capture}.compiler`));
		expect(compiler.captureIdentity).toBe(captureIdentity);
		expect(compiler.totalSiteCount).toBeGreaterThan(0);
		expect(compiler.trackedSiteCount).toBe(compiler.totalSiteCount);
		expect(compiler.bySite.some((events) => events.executions > 0)).toBe(true);
		expect(compiler.bySite.some((events) => events.safepoints > 0)).toBe(true);
		expect(compiler.allocations.some((entry) => entry.chargedBytes > 0)).toBe(true);
	});

	it("records explicitly nested phase boundaries on the monotonic timeline", () => {
		const capture = path.join(directory, "phases.bin");
		const result = spawnSync(phaseBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		const records = parseProfileCapture(readFileSync(capture)).records.filter(
			(record) => record.kind === 5 || record.kind === 6,
		);
		expect(records.map((record) => [record.kind, record.value])).toEqual([
			[5, 1],
			[5, 2],
			[6, 2],
			[6, 1],
		]);
		expect(records[3]!.timestampNs).toBeGreaterThanOrEqual(records[0]!.timestampNs);
	});

	it("attributes native dispatch, string, regexp, and host entries to exact sites", () => {
		const capture = path.join(directory, "runtime-attribution.bin");
		const result = spawnSync(runtimeBinary, [], {
			env: {
				...process.env,
				MAL_PROFILE_CAPTURE: capture,
				MAL_PROFILE_COMPILER: "1",
				MAL_PROFILE_IDENTITY: captureIdentity,
			},
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		const compiler = parseCompilerCapture(readFileSync(`${capture}.compiler`));
		const total = (
			name: "runtimeDispatch" | "runtimeString" | "runtimeRegExp" | "runtimeHost",
		): number => compiler.bySite.reduce((sum, events) => sum + events[name], 0);
		expect(total("runtimeDispatch")).toBeGreaterThan(0);
		expect(total("runtimeString")).toBeGreaterThan(0);
		expect(total("runtimeRegExp")).toBeGreaterThan(0);
		expect(total("runtimeHost")).toBeGreaterThan(0);
	});
});
