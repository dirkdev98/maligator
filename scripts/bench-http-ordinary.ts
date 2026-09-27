import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
	formatOhaDuration,
	parseCheckedOhaOutput,
	planExpressHttpWorkload,
} from "./bench-http.ts";
import type { ExpressHttpWorkload, OhaMetrics } from "./bench-http.ts";
import { cleanTestEnvironment } from "./test-environment.ts";

type Revision = "base" | "head";
type ServerKind = "bare" | "express";

interface Binaries {
	bare: string;
	express: string;
}

export interface HttpPreparation {
	binaries: Record<Revision, Binaries>;
	identity: {
		fixtures: Record<string, string>;
		configurations: Record<ServerKind, string>;
		binaries: Record<Revision, Record<ServerKind, string>>;
		tools: { node: string; oha: string; cc: string; rust: string };
	};
}

function digest(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function toolVersion(command: string, cwd?: string, required = true): string {
	const result = spawnSync(command, ["--version"], {
		encoding: "utf8",
		env: cleanTestEnvironment(),
		cwd,
	});
	if (result.status !== 0) {
		if (required) throw new Error(`HTTP benchmark tool unavailable: ${command}`);
		return "unavailable";
	}
	return result.stdout.split("\n")[0] ?? "";
}

function fixtureDigest(root: string, relative: string): string {
	const target = path.join(root, relative);
	const hash = createHash("sha256");
	const visit = (location: string): void => {
		for (const entry of readdirSync(location, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			if (entry.name === "node_modules" || entry.name === ".cache") continue;
			const child = path.join(location, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) {
				hash.update(path.relative(target, child));
				hash.update(readFileSync(child));
			}
		}
	};
	if (relative.endsWith(".js") || relative.endsWith(".cjs"))
		return digest(readFileSync(target));
	visit(target);
	return hash.digest("hex");
}

function terminateGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function cleanupOnInterrupt(children: Set<ReturnType<typeof spawn>>): {
	dispose: () => void;
	assertActive: () => void;
} {
	let interrupted = false;
	const onInterrupt = (exitCode: number) => {
		interrupted = true;
		for (const child of children) terminateGroup(child, "SIGKILL");
		process.exitCode = exitCode;
	};
	const onInt = () => onInterrupt(130);
	const onTerm = () => onInterrupt(143);
	process.once("SIGINT", onInt);
	process.once("SIGTERM", onTerm);
	return {
		dispose: () => {
			process.off("SIGINT", onInt);
			process.off("SIGTERM", onTerm);
		},
		assertActive: () => {
			if (interrupted) throw new Error("HTTP comparison interrupted");
		},
	};
}

async function runBuild(
	root: string,
	fixture: string,
	config: string,
	artifact: string,
	deadline: number,
): Promise<string> {
	const timeout = Math.max(
		1,
		Math.min(1_800_000, Math.floor(deadline - performance.now())),
	);
	const child = spawn(
		process.execPath,
		[
			path.join(root, "src/index.ts"),
			"build",
			path.join(root, fixture),
			"--production",
			"--config",
			config,
			"--artifact",
			artifact,
		],
		{
			cwd: root,
			env: cleanTestEnvironment(),
			stdio: ["ignore", "ignore", "pipe"],
			detached: true,
		},
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-8192);
	});
	const interruption = cleanupOnInterrupt(new Set([child]));
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				terminateGroup(child, "SIGKILL");
				reject(new Error(`HTTP ${fixture} build exceeded its time budget`));
			}, timeout);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else reject(new Error(`HTTP ${fixture} build failed: ${stderr}`));
			});
		});
		interruption.assertActive();
	} finally {
		interruption.dispose();
	}
	const manifest = JSON.parse(
		readFileSync(path.join(artifact, "artifact.json"), "utf8"),
	) as { name: string; production: boolean };
	if (manifest.production !== true || !/^[A-Za-z0-9_.-]+$/.test(manifest.name))
		throw new Error("HTTP build omitted production artifact");
	const binary = path.join(artifact, "bin", manifest.name);
	if (!existsSync(binary)) throw new Error(`HTTP build omitted ${binary}`);
	return binary;
}

export async function prepareHttpBinaries(
	base: string,
	head: string,
	directory: string,
	deadline: number,
): Promise<HttpPreparation> {
	const fixtures = [
		"bench/http/server_mal.js",
		"bench/http/express-server.cjs",
		"tests/fixtures/express-5",
	];
	const fixtureHashes = Object.fromEntries(
		fixtures.map((fixture) => [fixture, fixtureDigest(head, fixture)]),
	);
	for (const fixture of fixtures) {
		if (fixtureDigest(base, fixture) !== fixtureHashes[fixture])
			throw new Error(`HTTP fixture differs between revisions: ${fixture}`);
	}
	const configurations = {
		bare: "export default { surface: { webPlatform: true } };\n",
		express: "export default { surface: { node: true, webPlatform: true } };\n",
	};
	const binaries = {} as Record<Revision, Binaries>;
	const binaryHashes = {} as Record<Revision, Record<ServerKind, string>>;
	for (const revision of ["base", "head"] as const) {
		const root = revision === "base" ? base : head;
		const artifacts = path.join(directory, "http-build", revision);
		mkdirSync(artifacts, { recursive: true });
		const values = {} as Binaries;
		const hashes = {} as Record<ServerKind, string>;
		for (const kind of ["bare", "express"] as const) {
			const config = path.join(directory, "http-build", `${kind}.build.mts`);
			writeFileSync(config, configurations[kind]);
			values[kind] = await runBuild(
				root,
				kind === "bare" ? "bench/http/server_mal.js" : "bench/http/express-server.cjs",
				config,
				path.join(artifacts, kind),
				deadline,
			);
			hashes[kind] = digest(readFileSync(values[kind]));
		}
		binaries[revision] = values;
		binaryHashes[revision] = hashes;
	}
	return {
		binaries,
		identity: {
			fixtures: fixtureHashes,
			configurations: {
				bare: digest(configurations.bare),
				express: digest(configurations.express),
			},
			binaries: binaryHashes,
			tools: {
				node: process.version,
				oha: toolVersion("oha"),
				cc: toolVersion(process.env.CC ?? "cc"),
				rust: toolVersion("rustc", path.join(head, "runtime/rust"), false),
			},
		},
	};
}

function ordinaryEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return cleanTestEnvironment({ ...extra, MAL_BENCH_CONTROL: "1" });
}

interface ServerProcess {
	child: ReturnType<typeof spawn>;
	stdout: string;
	stderr: string;
	error?: Error;
}

function start(
	command: string,
	args: Array<string>,
	extra: NodeJS.ProcessEnv = {},
): ServerProcess {
	const child = spawn(command, args, {
		env: ordinaryEnvironment(extra),
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const server: ServerProcess = { child, stdout: "", stderr: "" };
	child.stdout?.on("data", (chunk: Buffer) => {
		server.stdout = (server.stdout + chunk.toString()).slice(-8192);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		server.stderr = (server.stderr + chunk.toString()).slice(-8192);
	});
	child.on("error", (error) => {
		server.error = error;
	});
	return server;
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.pid === undefined) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	terminateGroup(child, "SIGTERM");
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			once(child, "exit"),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					terminateGroup(child, "SIGKILL");
					reject(new Error("HTTP server required forced shutdown"));
				}, 5000);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function stopBoth(
	left: ReturnType<typeof spawn>,
	right: ReturnType<typeof spawn>,
): Promise<void> {
	const results = await Promise.allSettled([stop(left), stop(right)]);
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
}

async function ready(
	server: ServerProcess,
	port: number,
	deadline: number,
): Promise<void> {
	const url = `http://127.0.0.1:${port}/`;
	while (performance.now() < deadline) {
		if (
			server.error !== undefined ||
			server.child.exitCode !== null ||
			server.child.signalCode !== null
		) {
			throw new Error(
				`HTTP server failed before startup: ${server.error?.message ?? server.stderr}`,
			);
		}
		if (!server.stdout.includes(`PORT ${port}`)) {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
			continue;
		}
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(500),
				redirect: "manual",
			});
			await response.arrayBuffer();
			return;
		} catch {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
		}
	}
	throw new Error(`HTTP server did not become ready: ${url}; ${server.stderr}`);
}

interface RequestSpec {
	path: string;
	method?: string;
	headers?: HeadersInit;
	body?: string;
}

type HttpWorkload = Omit<ExpressHttpWorkload, "name"> & { name: string };

async function responseOracle(
	port: number,
	request: RequestSpec,
	deadline: number,
): Promise<{ status: number; body: string; headers: Record<string, string | null> }> {
	const remaining = Math.floor(deadline - performance.now());
	if (remaining <= 0) throw new Error("HTTP comparison time budget exhausted");
	const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
		method: request.method,
		headers: request.headers,
		body: request.body,
		redirect: "manual",
		signal: AbortSignal.timeout(Math.min(5000, remaining)),
	});
	return {
		status: response.status,
		body: await response.text(),
		headers: Object.fromEntries(
			["content-type", "location", "set-cookie"].map((key) => [
				key,
				response.headers.get(key),
			]),
		),
	};
}

async function assertResponses(
	malPort: number,
	nodePort: number,
	requests: Array<RequestSpec>,
	deadline: number,
): Promise<{ digest: string; statuses: Array<number> }> {
	const oracles = [];
	for (const request of requests) {
		const maligator = await responseOracle(malPort, request, deadline);
		const node = await responseOracle(nodePort, request, deadline);
		if (JSON.stringify(maligator) !== JSON.stringify(node))
			throw new Error(
				`HTTP response mismatch for ${request.method ?? "GET"} ${request.path}: ${JSON.stringify({ maligator, node })}`,
			);
		oracles.push({ request, response: maligator });
	}
	return {
		digest: digest(JSON.stringify(oracles)),
		statuses: [...new Set(oracles.map(({ response }) => response.status))],
	};
}

function oha(
	url: string,
	seconds: number,
	expectedStatuses: Array<number>,
	directory: string,
	label: string,
	deadline: number,
	args: Array<string> = [],
): OhaMetrics {
	const remaining = Math.floor(deadline - performance.now());
	if (remaining <= 0) throw new Error("HTTP comparison time budget exhausted");
	const result = spawnSync(
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
			...args,
			url,
		],
		{
			encoding: "utf8",
			env: cleanTestEnvironment({ NO_COLOR: "false" }),
			timeout: Math.min(Math.ceil((seconds + 10) * 1000), remaining),
		},
	);
	if (result.status !== 0)
		throw new Error(`oha failed for ${label}: ${result.stderr || result.error?.message}`);
	if (performance.now() >= deadline)
		throw new Error("HTTP comparison time budget exhausted");
	writeFileSync(path.join(directory, `${label}.oha.json`), result.stdout);
	return parseCheckedOhaOutput(result.stdout, expectedStatuses);
}

function usage(
	pid: number | undefined,
): { cpuMs: number; peakRssBytes: number; measurementScope: string } | undefined {
	if (pid === undefined || process.platform !== "linux") return undefined;
	try {
		const statText = readFileSync(`/proc/${pid}/stat`, "utf8");
		const stat = statText
			.slice(statText.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/);
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const hwm = Number(status.match(/^VmHWM:\s+(\d+) kB/m)?.[1]);
		const ticks = Number(
			spawnSync("getconf", ["CLK_TCK"], {
				encoding: "utf8",
				env: cleanTestEnvironment(),
			}).stdout.trim(),
		);
		const cpuMs = ((Number(stat[11]) + Number(stat[12])) * 1000) / ticks;
		if (
			!Number.isFinite(ticks) ||
			ticks <= 0 ||
			!Number.isFinite(hwm) ||
			hwm <= 0 ||
			!Number.isFinite(cpuMs) ||
			cpuMs < 0
		)
			return undefined;
		return {
			cpuMs,
			peakRssBytes: hwm * 1024,
			measurementScope: "process lifetime through post-load probe, excluding shutdown",
		};
	} catch {
		return undefined;
	}
}

function median(values: Array<number>): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

function workloadArgs(workload: HttpWorkload): Array<string> {
	const result: Array<string> = [];
	if (workload.method !== undefined) result.push("--method", workload.method);
	for (const header of workload.headers ?? []) result.push("-H", header);
	if (workload.body !== undefined) result.push("-d", workload.body);
	return result;
}

export async function runHttpSnapshot(
	binaries: Binaries,
	root: string,
	directory: string,
	seconds: number,
	deadline: number,
): Promise<unknown> {
	mkdirSync(directory, { recursive: true });
	const results: Record<string, unknown> = {};
	const oracles: Record<string, string> = {};
	const active = new Set<ReturnType<typeof spawn>>();
	const interruption = cleanupOnInterrupt(active);
	try {
		for (const kind of ["bare", "express"] as const) {
			interruption.assertActive();
			if (performance.now() >= deadline)
				throw new Error("HTTP comparison time budget exhausted");
			const malPort = kind === "bare" ? 3111 : 3113;
			const nodePort = kind === "bare" ? 3112 : 3114;
			const mal = start(
				binaries[kind],
				[],
				kind === "express" ? { PORT: String(malPort) } : {},
			);
			const node = start(
				process.execPath,
				[
					path.join(
						root,
						kind === "bare"
							? "bench/http/server_node.js"
							: "bench/http/express-server.cjs",
					),
				],
				kind === "express" ? { PORT: String(nodePort) } : {},
			);
			active.add(mal.child);
			active.add(node.child);
			try {
				await ready(mal, malPort, Math.min(deadline, performance.now() + 10000));
				await ready(node, nodePort, Math.min(deadline, performance.now() + 10000));
				const warmPath = kind === "bare" ? "/" : "/middleware";
				for (const [index, port] of [malPort, nodePort].entries()) {
					oha(
						`http://127.0.0.1:${port}${warmPath}`,
						2,
						[200],
						directory,
						`${kind}-warm-${index}`,
						deadline,
					);
				}
				const workloads: Array<HttpWorkload> =
					kind === "bare"
						? [
								{
									name: "bare",
									durationSeconds: seconds,
									paths: ["/"],
								},
							]
						: planExpressHttpWorkload(seconds);
				const entries: Record<string, unknown> = {};
				for (const workload of workloads) {
					const headers = workload.headers?.map((value): [string, string] => {
						const separator = value.indexOf(":");
						if (separator < 0) throw new Error(`invalid HTTP workload header: ${value}`);
						return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
					});
					const requests = workload.paths.map((requestPath) => ({
						path: requestPath,
						method: workload.method,
						headers,
						body: workload.body,
					}));
					const before = await assertResponses(malPort, nodePort, requests, deadline);
					const paths = path.join(directory, `${kind}-${workload.name}-paths.txt`);
					writeFileSync(
						paths,
						`${workload.paths.map((value) => `http://127.0.0.1:${malPort}${value}`).join("\n")}\n`,
					);
					const nodePaths = path.join(
						directory,
						`${kind}-${workload.name}-node-paths.txt`,
					);
					writeFileSync(
						nodePaths,
						`${workload.paths.map((value) => `http://127.0.0.1:${nodePort}${value}`).join("\n")}\n`,
					);
					const extra = workloadArgs(workload);
					const malSamples: Array<OhaMetrics> = [];
					const nodeSamples: Array<OhaMetrics> = [];
					for (const [index, target] of [paths, nodePaths].entries()) {
						const sample = oha(
							target,
							workload.durationSeconds,
							before.statuses,
							directory,
							`${kind}-${workload.name}-${index}`,
							deadline,
							["--urls-from-file", ...extra],
						);
						if (index === 0) malSamples.push(sample);
						else nodeSamples.push(sample);
					}
					const after = await assertResponses(malPort, nodePort, requests, deadline);
					if (before.digest !== after.digest)
						throw new Error(`HTTP response changed during ${workload.name}`);
					oracles[`${kind}.${workload.name}`] = before.digest;
					const malRps = median(malSamples.map((sample) => sample.rps));
					const nodeRps = median(nodeSamples.map((sample) => sample.rps));
					entries[workload.name] = {
						malRps,
						nodeRps,
						ratio: malRps / nodeRps,
						malP99Ms: median(malSamples.map((sample) => sample.p99Ms)),
						nodeP99Ms: median(nodeSamples.map((sample) => sample.p99Ms)),
					};
				}
				const resource = usage(mal.child.pid);
				if (process.platform === "linux" && resource === undefined) {
					throw new Error(`HTTP ${kind} process CPU/RSS evidence is unavailable`);
				}
				results[kind] =
					kind === "bare"
						? { ...(entries.bare as object), resource }
						: { workloads: entries, resource };
			} finally {
				try {
					await stopBoth(mal.child, node.child);
				} finally {
					active.delete(mal.child);
					active.delete(node.child);
				}
			}
		}
		interruption.assertActive();
		return {
			http: {
				world: "closed",
				instrumentation: "none",
				oracleDigest: digest(JSON.stringify(oracles)),
				...results,
			},
		};
	} finally {
		interruption.dispose();
	}
}
