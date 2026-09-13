import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-process-events-"));

interface Session {
	lines: Array<string>;
	status: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

/** A spawned fixture plus the plumbing to await its ordered stdout lines. */
class Fixture {
	private readonly child: ChildProcessByStdio<null, Readable, Readable>;
	private readonly waiters: Array<{
		match: (line: string) => boolean;
		resolve: (line: string) => void;
	}> = [];
	readonly lines: Array<string> = [];
	stderr = "";
	private readonly exited: Promise<{
		status: number | null;
		signal: NodeJS.Signals | null;
	}>;
	private pending = "";

	constructor(binary: string, env: NodeJS.ProcessEnv) {
		this.child = spawn(binary, [], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});
		this.child.stdout.on("data", (chunk: Buffer) => this.absorb(chunk.toString()));
		this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
		this.exited = new Promise((resolve) => {
			this.child.on("close", (status, signal) => resolve({ status, signal }));
		});
	}

	private absorb(text: string): void {
		this.pending += text;
		let newline = this.pending.indexOf("\n");
		while (newline >= 0) {
			const line = this.pending.slice(0, newline).trim();
			this.pending = this.pending.slice(newline + 1);
			if (line.length > 0) {
				this.lines.push(line);
				const index = this.waiters.findIndex((waiter) => waiter.match(line));
				if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(line);
			}
			newline = this.pending.indexOf("\n");
		}
	}

	/** Resolve with the first line starting with `prefix`, past or future. */
	async line(prefix: string, timeoutMs = 15000): Promise<string> {
		const match = (line: string) => line.startsWith(prefix);
		const seen = this.lines.find(match);
		if (seen !== undefined) return seen;
		return await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`timed out waiting for "${prefix}"; saw: ${JSON.stringify(this.lines)}`,
					),
				);
			}, timeoutMs);
			this.waiters.push({
				match,
				resolve: (line) => {
					clearTimeout(timer);
					resolve(line);
				},
			});
		});
	}

	send(signal: NodeJS.Signals): void {
		this.child.kill(signal);
	}

	async end(): Promise<Session> {
		const { status, signal } = await this.exited;
		return { lines: this.lines, status, signal, stderr: this.stderr };
	}

	kill(): void {
		this.child.kill("SIGKILL");
	}
}

async function withFixture(
	binary: string,
	env: NodeJS.ProcessEnv,
	body: (fixture: Fixture) => Promise<void>,
): Promise<Session> {
	const fixture = new Fixture(binary, env);
	try {
		await body(fixture);
		return await fixture.end();
	} catch (error) {
		fixture.kill();
		throw error;
	}
}

function expectTermination(
	session: Session,
	expected: { status: number | null; signal: NodeJS.Signals | null },
): void {
	const detail = `stdout=${JSON.stringify(session.lines)} stderr=${JSON.stringify(session.stderr)}`;
	expect(session.status, detail).toBe(expected.status);
	expect(session.signal, detail).toBe(expected.signal);
}

function expectSpawnTermination(
	run: ReturnType<typeof spawnSync>,
	expectedStatus: number,
): void {
	const detail = `signal=${String(run.signal)} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`;
	expect(run.status, detail).toBe(expectedStatus);
}

function explicitExitEnvironment(): NodeJS.ProcessEnv {
	const asanOptions = process.env.ASAN_OPTIONS;
	return {
		...process.env,
		NODE_SIGNAL_MODE: "no-before-exit-on-exit",
		// Forced exit bypasses MAL_GC_AT_EXIT; only this child skips leak classification.
		...(asanOptions === undefined
			? {}
			: { ASAN_OPTIONS: `${asanOptions}:detect_leaks=0` }),
	};
}

describe("process as an EventEmitter", () => {
	let events: string;
	let eventsInterpreted: string;
	let processWithoutEvents: string;
	let shutdown: string;

	beforeAll(() => {
		events = buildNativeBinary({
			fixture: "tests/local/node-process-events.mts",
			name: "node-process-events",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		eventsInterpreted = buildNativeBinary({
			fixture: "tests/local/node-process-events.mts",
			name: "node-process-events-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		processWithoutEvents = buildNativeBinary({
			fixture: "tests/local/node-process-without-events.mts",
			name: "node-process-without-events",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		shutdown = buildNativeBinary({
			fixture: "tests/local/node-process-graceful-shutdown.cjs",
			name: "node-process-graceful-shutdown",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	}, 900_000);

	it("passes the identity, dispatch, and beforeExit self-checks", () => {
		assertResultPass(runToStdout(events));
	});

	it("passes the same self-checks on the interpreter", () => {
		assertResultPass(runToStdout(eventsInterpreted));
	});

	it("keeps listeners rooted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(events, { env: STRESS_ENV }));
	});

	it("emits beforeExit once per drain, re-notifying rescheduled work", () => {
		const lines = runToStdout(events)
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.startsWith("BEFORE_EXIT") || line.startsWith("RESCHEDULED"));
		expect(lines).toEqual([
			"BEFORE_EXIT 1 0",
			"RESCHEDULED_TIMER",
			"BEFORE_EXIT 2 0",
			"RESCHEDULED_IMMEDIATE",
			"BEFORE_EXIT 3 0",
		]);
	});

	it("materializes EventEmitter behavior without importing node:events", () => {
		assertResultPass(runToStdout(processWithoutEvents));
	});

	it("delivers repeated SIGINT and then SIGTERM to their listeners", async () => {
		const session = await withFixture(
			events,
			{ NODE_SIGNAL_MODE: "deliver" },
			async (f) => {
				await f.line("READY");
				f.send("SIGINT");
				await f.line("SIGNAL SIGINT 1");
				f.send("SIGINT");
				await f.line("SIGNAL SIGINT 2");
				f.send("SIGTERM");
				await f.line("DONE");
			},
		);
		expectTermination(session, { status: 0, signal: null });
		expect(session.lines).toContain("DONE SIGINT,SIGINT,SIGTERM");
	});

	it("delivers signals under MAL_GC_STRESS + MAL_GC_VERIFY", async () => {
		const session = await withFixture(
			events,
			{ ...STRESS_ENV, NODE_SIGNAL_MODE: "deliver" },
			async (f) => {
				await f.line("READY");
				f.send("SIGTERM");
				await f.line("DONE");
			},
		);
		expectTermination(session, { status: 0, signal: null });
		expect(session.lines).toContain("DONE SIGTERM");
	});

	it("runs a once() signal listener exactly once, then restores the default action", async () => {
		const session = await withFixture(events, { NODE_SIGNAL_MODE: "once" }, async (f) => {
			await f.line("READY");
			f.send("SIGINT");
			await f.line("SIGNAL SIGINT 1");
			f.send("SIGINT");
		});
		// The second SIGINT finds no listener, so the default action terminates.
		expectTermination(session, { status: null, signal: "SIGINT" });
		expect(session.lines.filter((line) => line.startsWith("SIGNAL "))).toEqual([
			"SIGNAL SIGINT 1",
		]);
	});

	it.each(["removed", "remove-all"])(
		"restores the default action after %s clears the listener",
		async (mode) => {
			const session = await withFixture(events, { NODE_SIGNAL_MODE: mode }, async (f) => {
				expect(await f.line("LISTENERS")).toBe("LISTENERS 0");
				await f.line("READY");
				f.send("SIGTERM");
			});
			expectTermination(session, { status: null, signal: "SIGTERM" });
			expect(session.lines.some((line) => line.startsWith("SIGNAL "))).toBe(false);
		},
	);

	it("does not emit beforeExit when a fatal signal terminates the process", async () => {
		const session = await withFixture(
			events,
			{ NODE_SIGNAL_MODE: "no-before-exit-on-signal" },
			async (f) => {
				await f.line("READY");
				f.send("SIGTERM");
			},
		);
		expectTermination(session, { status: null, signal: "SIGTERM" });
		expect(session.lines).not.toContain("BEFORE_EXIT");
	});

	it("does not emit beforeExit for an explicit process.exit()", () => {
		const run = spawnSync(events, [], {
			encoding: "utf-8",
			timeout: 20000,
			env: explicitExitEnvironment(),
		});
		expectSpawnTermination(run, 7);
		expect(run.stdout).toContain("EXITING");
		expect(run.stdout).not.toContain("BEFORE_EXIT");
	});

	it("does not emit beforeExit after an uncaught top-level exception", () => {
		const run = spawnSync(events, [], {
			encoding: "utf-8",
			timeout: 20000,
			env: { ...process.env, NODE_SIGNAL_MODE: "no-before-exit-on-throw" },
		});
		expectSpawnTermination(run, 1);
		expect(run.stdout).not.toContain("BEFORE_EXIT");
	});

	it("shuts an Express server down gracefully on SIGTERM", async () => {
		const session = await withFixture(shutdown, {}, async (f) => {
			const port = Number((await f.line("PORT ")).slice("PORT ".length));
			const response = await fetch(`http://127.0.0.1:${port}/users/42`);
			expect(response.status).toBe(200);
			await response.json();
			f.send("SIGTERM");
			await f.line("CLOSED");
		});
		expectTermination(session, { status: 0, signal: null });
		expect(session.lines).toContain("SHUTDOWN SIGTERM");
		expect(session.lines).toContain("CLOSED");
		expect(session.lines).toContain("BEFORE_EXIT after-shutdown");
	});
});
