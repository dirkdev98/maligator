/**
 * Product-profiler overhead gate.
 *
 * Builds ordinary and sampling images from the same source, alternates their
 * execution order, verifies identical output, parses every profile capture, and
 * reports the median paired wall-time or throughput cost. This lane is diagnostic:
 * it never updates bench/baseline.json.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseProfileCapture } from "../src/profile-artifact.ts";
import { buildNativeBinary, HOST_MAIN } from "../src/test-harness.ts";
import { formatOhaDuration, parseOhaOutput } from "./bench-http.ts";

interface Options {
	runs: number;
	httpSeconds: number;
	thresholdPercent: number;
	jsonOut?: string;
}

interface CaptureHealth {
	cpuSamples: number;
	allocationSamples: number;
	droppedRecords: number;
	droppedFrames: number;
}

interface LaneResult {
	kind: "wall" | "throughput";
	ordinary: number;
	profile: number;
	overheadPercent: number;
	pairOverheadsPercent: Array<number>;
	capture: CaptureHealth;
}

interface OverheadReport {
	schema: 1;
	runs: number;
	thresholdPercent: number;
	passed: boolean;
	lanes: Record<string, LaneResult>;
}

const HELP = `Usage: node scripts/profile-overhead.ts [options]

Options:
  --runs N             Alternating pairs per lane (default: 5)
  --http-seconds N     Seconds per HTTP image in each pair (default: 3)
  --threshold N        Maximum median overhead percent (default: 3)
  --json-out PATH      Also write the complete raw-pair report as JSON
  --help               Show this help without building
`;

function parsePositiveNumber(value: string | undefined, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${option} requires a positive number`);
	}
	return parsed;
}

function parseOptions(args: Array<string>): Options | undefined {
	if (args.includes("--help")) {
		console.log(HELP);
		return undefined;
	}
	const options: Options = { runs: 5, httpSeconds: 3, thresholdPercent: 3 };
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (option === "--runs") {
			options.runs = parsePositiveNumber(args[++index], option);
		} else if (option === "--http-seconds") {
			options.httpSeconds = parsePositiveNumber(args[++index], option);
		} else if (option === "--threshold") {
			options.thresholdPercent = parsePositiveNumber(args[++index], option);
		} else if (option === "--json-out") {
			const output = args[++index];
			if (output === undefined || output.startsWith("--")) {
				throw new Error("--json-out requires a path");
			}
			options.jsonOut = output;
		} else {
			throw new Error(`unknown option: ${option}`);
		}
	}
	if (!Number.isInteger(options.runs) || options.runs < 3) {
		throw new Error("--runs must be an integer of at least 3");
	}
	return options;
}

function median(values: Array<number>): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function validateCapture(capturePath: string): CaptureHealth {
	if (!existsSync(capturePath)) throw new Error(`profile omitted ${capturePath}`);
	const capture = parseProfileCapture(readFileSync(capturePath));
	// Phase markers extended the raw format from v3 to v4 without changing the
	// process-CPU/Poisson sampling contract this gate verifies. Accept that
	// contract instead of pinning the newest additive container version.
	if (capture.schema < 3 || capture.samplingClock !== "process-cpu") {
		throw new Error(`${capturePath} used an obsolete capture or sampling clock`);
	}
	const health = {
		cpuSamples: capture.records.filter((record) => record.kind === 1).length,
		allocationSamples: capture.records.filter((record) => record.kind === 2).length,
		droppedRecords: capture.droppedRecords,
		droppedFrames: capture.droppedFrames,
	};
	if (health.cpuSamples === 0) throw new Error(`${capturePath} contained no CPU samples`);
	return health;
}

function addCaptureHealth(left: CaptureHealth, right: CaptureHealth): CaptureHealth {
	return {
		cpuSamples: left.cpuSamples + right.cpuSamples,
		allocationSamples: left.allocationSamples + right.allocationSamples,
		droppedRecords: left.droppedRecords + right.droppedRecords,
		droppedFrames: left.droppedFrames + right.droppedFrames,
	};
}

function runBinary(
	binary: string,
	environment: NodeJS.ProcessEnv,
): { wallMs: number; stdout: string } {
	const started = process.hrtime.bigint();
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...environment },
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
	if (result.status !== 0) {
		throw new Error(
			`${binary} failed with status ${result.status}:\n${result.stderr ?? ""}`,
		);
	}
	return { wallMs, stdout: result.stdout ?? "" };
}

function measureDirectLane(
	name: string,
	fixture: string,
	runs: number,
	directory: string,
	buildEnvironment: NodeJS.ProcessEnv = {},
): LaneResult {
	console.log(`building ${name} images...`);
	const environment = { ...process.env, ...buildEnvironment };
	const ordinary = buildNativeBinary({
		fixture,
		name: `profile-overhead-${name}-ordinary`,
		environment,
	});
	const profile = buildNativeBinary({
		fixture,
		name: `profile-overhead-${name}-profile`,
		profileEnabled: true,
		environment,
	});

	const preflightCapture = path.join(directory, `${name}-preflight.bin`);
	const ordinaryPreflight = runBinary(ordinary, {
		...buildEnvironment,
		MAL_GC_VERIFY: "1",
	});
	const profilePreflight = runBinary(profile, {
		...buildEnvironment,
		MAL_GC_VERIFY: "1",
		MAL_PROFILE_CAPTURE: preflightCapture,
	});
	if (ordinaryPreflight.stdout !== profilePreflight.stdout) {
		throw new Error(`${name} ordinary/profile output mismatch`);
	}
	let captureHealth = validateCapture(preflightCapture);

	const ordinaryTimes: Array<number> = [];
	const profileTimes: Array<number> = [];
	const pairOverheads: Array<number> = [];
	for (let pair = 0; pair < runs; pair++) {
		console.log(`  ${name} pair ${pair + 1}/${runs}`);
		const capturePath = path.join(directory, `${name}-${pair}.bin`);
		let ordinaryRun: ReturnType<typeof runBinary>;
		let profileRun: ReturnType<typeof runBinary>;
		const runOrdinary = () => runBinary(ordinary, buildEnvironment);
		const runProfile = () =>
			runBinary(profile, {
				...buildEnvironment,
				MAL_PROFILE_CAPTURE: capturePath,
			});
		if (pair % 2 === 0) {
			ordinaryRun = runOrdinary();
			profileRun = runProfile();
		} else {
			profileRun = runProfile();
			ordinaryRun = runOrdinary();
		}
		if (ordinaryRun.stdout !== profileRun.stdout) {
			throw new Error(`${name} ordinary/profile output mismatch in pair ${pair + 1}`);
		}
		ordinaryTimes.push(ordinaryRun.wallMs);
		profileTimes.push(profileRun.wallMs);
		pairOverheads.push((profileRun.wallMs / ordinaryRun.wallMs - 1) * 100);
		captureHealth = addCaptureHealth(captureHealth, validateCapture(capturePath));
	}
	return {
		kind: "wall",
		ordinary: median(ordinaryTimes),
		profile: median(profileTimes),
		overheadPercent: median(pairOverheads),
		pairOverheadsPercent: pairOverheads,
		capture: captureHealth,
	};
}

function ohaAvailable(): boolean {
	return spawnSync("oha", ["--version"], { stdio: "ignore" }).status === 0;
}

function ohaRun(url: string, seconds: number): number {
	const output = execFileSync(
		"oha",
		[
			"-z",
			formatOhaDuration(seconds),
			"-c",
			"50",
			"--no-tui",
			"--output-format",
			"json",
			"--redirect",
			"0",
			url,
		],
		{ encoding: "utf-8", env: { ...process.env, NO_COLOR: "false" } },
	);
	return parseOhaOutput(output).rps;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("could not reserve a loopback port"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolve(address.port);
			});
		});
	});
}

async function waitReachable(child: ChildProcess, url: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`HTTP image exited before listening at ${url}`);
		}
		try {
			const response = await fetch(url);
			await response.arrayBuffer();
			return;
		} catch {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		}
	}
	throw new Error(`HTTP image did not listen at ${url}`);
}

async function responseFingerprint(url: string): Promise<string> {
	const response = await fetch(url);
	return JSON.stringify({
		status: response.status,
		contentType: response.headers.get("content-type"),
		body: await response.text(),
	});
}

async function terminate(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
	child.kill("SIGTERM");
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			exited,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error("HTTP image did not terminate after SIGTERM")),
					5_000,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function measureHttpLane(
	runs: number,
	seconds: number,
	directory: string,
): Promise<LaneResult> {
	if (!ohaAvailable()) throw new Error("profile overhead HTTP gate requires `oha`");
	console.log("building HTTP images...");
	const ordinary = buildNativeBinary({
		fixture: "bench/http/express-server.cjs",
		name: "profile-overhead-http-ordinary",
		mainFile: HOST_MAIN,
		nodeEnabled: true,
	});
	const profile = buildNativeBinary({
		fixture: "bench/http/express-server.cjs",
		name: "profile-overhead-http-profile",
		mainFile: HOST_MAIN,
		nodeEnabled: true,
		profileEnabled: true,
	});
	const ordinaryPort = await freePort();
	const profilePort = await freePort();
	const capturePath = path.join(directory, "http.bin");
	const ordinaryChild = spawn(ordinary, [], {
		env: { ...process.env, PORT: String(ordinaryPort) },
		stdio: "ignore",
	});
	const profileChild = spawn(profile, [], {
		env: {
			...process.env,
			PORT: String(profilePort),
			MAL_PROFILE_CAPTURE: capturePath,
		},
		stdio: "ignore",
	});
	const ordinaryUrl = `http://127.0.0.1:${ordinaryPort}/middleware`;
	const profileUrl = `http://127.0.0.1:${profilePort}/middleware`;
	const ordinaryRps: Array<number> = [];
	const profileRps: Array<number> = [];
	const pairOverheads: Array<number> = [];
	try {
		await Promise.all([
			waitReachable(ordinaryChild, ordinaryUrl),
			waitReachable(profileChild, profileUrl),
		]);
		const [ordinaryResponse, profileResponse] = await Promise.all([
			responseFingerprint(ordinaryUrl),
			responseFingerprint(profileUrl),
		]);
		if (ordinaryResponse !== profileResponse) {
			throw new Error("HTTP ordinary/profile response mismatch");
		}
		ohaRun(ordinaryUrl, 1);
		ohaRun(profileUrl, 1);
		for (let pair = 0; pair < runs; pair++) {
			console.log(`  HTTP pair ${pair + 1}/${runs}`);
			let ordinaryValue: number;
			let profileValue: number;
			if (pair % 2 === 0) {
				ordinaryValue = ohaRun(ordinaryUrl, seconds);
				profileValue = ohaRun(profileUrl, seconds);
			} else {
				profileValue = ohaRun(profileUrl, seconds);
				ordinaryValue = ohaRun(ordinaryUrl, seconds);
			}
			ordinaryRps.push(ordinaryValue);
			profileRps.push(profileValue);
			pairOverheads.push((1 - profileValue / ordinaryValue) * 100);
		}
	} finally {
		await Promise.all([terminate(ordinaryChild), terminate(profileChild)]);
	}
	return {
		kind: "throughput",
		ordinary: median(ordinaryRps),
		profile: median(profileRps),
		overheadPercent: median(pairOverheads),
		pairOverheadsPercent: pairOverheads,
		capture: validateCapture(capturePath),
	};
}

function formatLane(name: string, lane: LaneResult, threshold: number): string {
	const unit = lane.kind === "wall" ? "ms" : "req/s";
	const complete = lane.capture.droppedRecords === 0 && lane.capture.droppedFrames === 0;
	const status = lane.overheadPercent <= threshold && complete ? "PASS" : "FAIL";
	const drops = complete
		? "complete"
		: `${lane.capture.droppedRecords} record / ${lane.capture.droppedFrames} frame drops`;
	return `${name.padEnd(18)} ${lane.ordinary.toFixed(1)} -> ${lane.profile.toFixed(1)} ${unit}; ${lane.overheadPercent >= 0 ? "+" : ""}${lane.overheadPercent.toFixed(2)}% overhead; ${lane.capture.cpuSamples} CPU / ${lane.capture.allocationSamples} allocation samples; ${drops}; ${status}`;
}

const options = parseOptions(process.argv.slice(2));
if (options !== undefined) {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-profile-overhead-"));
	try {
		const lanes: Record<string, LaneResult> = {};
		lanes.language = measureDirectLane(
			"language",
			"bench/language.js",
			options.runs,
			directory,
		);
		lanes["allocation-heavy"] = measureDirectLane(
			"allocation-heavy",
			"bench/stack-object.js",
			options.runs,
			directory,
		);
		lanes.gc = measureDirectLane("gc", "bench/gc/server.js", options.runs, directory, {
			MAL_GC_GENERATIONAL: "1",
		});
		lanes.http = await measureHttpLane(options.runs, options.httpSeconds, directory);
		const passed = Object.values(lanes).every(
			(lane) =>
				lane.overheadPercent <= options.thresholdPercent &&
				lane.capture.droppedRecords === 0 &&
				lane.capture.droppedFrames === 0,
		);
		const report: OverheadReport = {
			schema: 1,
			runs: options.runs,
			thresholdPercent: options.thresholdPercent,
			passed,
			lanes,
		};
		console.log(`\nprofile overhead (${options.runs} alternating pairs):`);
		for (const [name, lane] of Object.entries(lanes)) {
			console.log(`  ${formatLane(name, lane, options.thresholdPercent)}`);
		}
		console.log(`  gate               ${passed ? "PASS" : "FAIL"}`);
		if (options.jsonOut !== undefined) {
			writeFileSync(options.jsonOut, `${JSON.stringify(report, undefined, 2)}\n`);
			console.log(`  raw report         ${path.resolve(options.jsonOut)}`);
		}
		if (!passed) process.exitCode = 1;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
