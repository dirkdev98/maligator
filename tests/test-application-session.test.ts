import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	ApplicationExit,
	ApplicationImageHost,
	ApplicationInstance,
	ApplicationLaunchOptions,
} from "../src/application-images.ts";
import { resolveBuildConfig } from "../src/build-config-values.ts";
import { productCompilerInstallation } from "../src/cli-commands.ts";
import type { CommandContext } from "../src/cli-commands.ts";
import type { TestCommand } from "../src/cli.ts";
import type { CompilationOptions } from "../src/compiler-service.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { FrontendCompilationSession } from "../src/frontend-cache.ts";
import {
	createTestApplicationSession,
	executeTestCommand,
} from "../src/testing/command.ts";
import { executeTestApplication } from "../src/testing/execute.ts";
import type {
	PreparedTestApplication,
	TestCompilationInput,
} from "../src/testing/prepare.ts";
import type { TestRunOptions, TestRunResult } from "../src/testing/protocol.ts";
import { watchTestCommand } from "../src/testing/watch.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

function channel<T>() {
	const queued: Array<T> = [];
	const waiters: Array<(value: T) => void> = [];
	return {
		push(value: T) {
			const waiter = waiters.shift();
			if (waiter === undefined) queued.push(value);
			else waiter(value);
		},
		next(): Promise<T> {
			const value = queued.shift();
			return value === undefined
				? new Promise((resolve) => {
						waiters.push(resolve);
					})
				: Promise.resolve(value);
		},
	};
}

function result(files: Array<string>): TestRunResult {
	return {
		passed: files.length,
		failed: 0,
		skipped: 0,
		todo: 0,
		focused: false,
		durationMs: 1,
		events: [],
		files: files.map((file) => ({
			file,
			passed: 1,
			failed: 0,
			skipped: 0,
			todo: 0,
			durationMs: 1,
		})),
	};
}

function applicationHost(
	publish = (files: Array<string>, _launch: number) => result(files),
) {
	let loads = 0;
	let releases = 0;
	let joins = 0;
	const launches: Array<ApplicationLaunchOptions> = [];
	const host: ApplicationImageHost = {
		load() {
			loads++;
			return {
				launch(options): ApplicationInstance {
					launches.push(options);
					const files = (options.data as TestRunOptions).files!;
					const exit: ApplicationExit = {
						id: launches.length,
						code: 0,
						reason: "completed",
						hasResult: true,
						result: publish(files, launches.length),
					};
					return {
						id: launches.length,
						ready: Promise.resolve(),
						applicationReady: new Promise(() => {}),
						closed: Promise.resolve(exit),
						port: {} as ApplicationInstance["port"],
						ref() {},
						unref() {},
						terminate() {
							joins++;
							return Promise.resolve(exit);
						},
					};
				},
				close() {
					releases++;
				},
			};
		},
	};
	return {
		host,
		launches,
		get loads() {
			return loads;
		},
		get releases() {
			return releases;
		},
		get joins() {
			return joins;
		},
	};
}

function prepared(input: TestCompilationInput): PreparedTestApplication {
	const identities = input.files.map((file) =>
		new FrontendCompilationSession().snapshot(file),
	);
	return {
		image: {
			schema: 1,
			wires: identities.map((dependency) => ({
				path: `${dependency.path}.malw`,
				sha256: dependency.digest,
			})),
			entryPath: input.files[0]!,
			node: false,
			webPlatform: false,
			engine: {
				primordials: "locked",
				eval: false,
				realms: false,
				regexp: true,
				temporal: false,
				intl: false,
			},
		},
		files: input.files,
		dependencies: input.files,
		dependencyIdentities: identities,
		cache: "miss",
		frontendMs: 1,
		phases: {
			validationMs: 0,
			graphMs: 0,
			semanticMs: 0,
			compileMs: 1,
			serializeMs: 0,
			workerMs: 0,
		},
		artifactHits: 0,
		artifactMisses: 1,
	};
}

describe("retained test application images", () => {
	it("closes its watcher and removes signals when the initial queued observer throws", async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-watch-start-"));
		const file = path.join(directory, "one.test.mts");
		writeFileSync(file, "export {};\n");
		const applications = applicationHost();
		const failure = new Error("initial test observer failed");
		const signalCounts = [
			process.listenerCount("SIGINT"),
			process.listenerCount("SIGTERM"),
			process.listenerCount("SIGHUP"),
		];
		let closed = false;
		let admitted = false;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
			if (String(text).includes("generation 1: queued")) throw failure;
			return true;
		});
		try {
			await expect(
				watchTestCommand(
					{
						kind: "test",
						paths: [file],
						watch: true,
						repeat: 1,
						bail: false,
						timeoutMs: 88,
						compileConcurrency: 1,
						profile: false,
					},
					{
						stripTypes: stripCompactTypes,
						installation: productCompilerInstallation(directory, "compiler", "test"),
						applications: applications.host,
						compiler: {
							prepare: () => Promise.reject(new Error("unused")),
							prepareTests(input) {
								admitted = true;
								return Promise.resolve(prepared(input));
							},
							close: () => Promise.resolve(),
						},
						developmentWatcher: {
							create: () => ({}),
							update() {},
							wait: () => Promise.resolve(),
							close() {
								closed = true;
							},
						},
					},
					() => resolveBuildConfig({}),
				),
			).rejects.toBe(failure);
			expect(closed).toBe(true);
			expect(admitted).toBe(false);
			expect(applications.loads).toBe(0);
			expect([
				process.listenerCount("SIGINT"),
				process.listenerCount("SIGTERM"),
				process.listenerCount("SIGHUP"),
			]).toEqual(signalCounts);
		} finally {
			stderr.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("drains compilation and releases retained images despite watcher close failure", async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-watch-close-"));
		const file = path.join(directory, "one.test.mts");
		writeFileSync(file, "export {};\n");
		const applications = applicationHost();
		const completed = deferred<void>();
		const admitted = deferred<CompilationOptions | undefined>();
		const reply = deferred<PreparedTestApplication>();
		const watcherClosed = deferred<void>();
		const failure = new Error("watcher close failed");
		let input!: TestCompilationInput;
		let compilations = 0;
		let wake = () => {};
		let finished = false;
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
			if (String(text).includes("generation 1: 0 failed; seed")) completed.resolve();
			return true;
		});
		const running = watchTestCommand(
			{
				kind: "test",
				paths: [file],
				watch: true,
				repeat: 1,
				bail: false,
				timeoutMs: 88,
				compileConcurrency: 1,
				profile: false,
			},
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(directory, "compiler", "test"),
				applications: applications.host,
				compiler: {
					prepare: () => Promise.reject(new Error("unused")),
					prepareTests(next, options) {
						input = next;
						if (++compilations === 1) return Promise.resolve(prepared(next));
						admitted.resolve(options);
						return reply.promise;
					},
					close: () => Promise.resolve(),
				},
				developmentWatcher: {
					create: () => ({}),
					update() {},
					wait: () =>
						new Promise<void>((resolve) => {
							wake = resolve;
						}),
					close() {
						watcherClosed.resolve();
						throw failure;
					},
				},
			},
			() => resolveBuildConfig({}),
		);
		const settled = running.then(
			() => {
				finished = true;
			},
			(error: unknown) => {
				finished = true;
				throw error;
			},
		);
		const assertion = expect(settled).rejects.toBe(failure);
		try {
			await completed.promise;
			writeFileSync(file, "export const revision = 1;\n");
			wake();
			const options = await admitted.promise;
			process.emit("SIGINT");
			wake();
			await watcherClosed.promise;
			await new Promise<void>((resolve) => {
				setImmediate(resolve);
			});
			expect(options?.signal?.aborted).toBe(true);
			expect(finished).toBe(false);
			reply.resolve(prepared(input));
			await assertion;
			expect(applications.loads).toBe(2);
			expect(applications.releases).toBe(applications.loads);
			expect(applications.joins).toBe(1);
		} finally {
			process.emit("SIGINT");
			wake();
			reply.resolve(prepared(input));
			await running.catch(() => {});
			output.mockRestore();
			stderr.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it.skipIf(process.platform === "win32")(
		"rediscovers added tests and asset members, then reruns unchanged state through the native signal control",
		async () => {
			const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test-watch-files-"));
			const tests = path.join(directory, "tests");
			const assets = path.join(directory, "assets");
			mkdirSync(tests);
			mkdirSync(assets);
			const first = path.join(tests, "one.test.mts");
			writeFileSync(first, "export {};\n");
			const configPath = path.join(directory, "maligator.build.mts");
			writeFileSync(configPath, "export default {};\n");
			const applications = applicationHost();
			const requests: Array<{
				input: TestCompilationInput;
				options: CompilationOptions | undefined;
			}> = [];
			const completed: Array<ReturnType<typeof deferred<void>>> = [
				deferred<void>(),
				deferred<void>(),
				deferred<void>(),
			];
			let wake = () => {};
			const output = vi.spyOn(console, "log").mockImplementation(() => {});
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
				const match = String(text).match(/Test watch generation (\d+): 0 failed; seed/);
				if (match !== null) completed[Number(match[1]) - 1]?.resolve();
				return true;
			});
			const running = watchTestCommand(
				{
					kind: "test",
					paths: [tests],
					configPath,
					watch: true,
					repeat: 1,
					bail: false,
					timeoutMs: 88,
					compileConcurrency: 1,
					profile: false,
				},
				{
					stripTypes: stripCompactTypes,
					installation: productCompilerInstallation(directory, "compiler", "test"),
					applications: applications.host,
					compiler: {
						prepare: () => Promise.reject(new Error("unused")),
						prepareTests(input, options) {
							requests.push({ input, options });
							return Promise.resolve(prepared(input));
						},
						close: () => Promise.resolve(),
					},
					developmentWatcher: {
						create() {
							return {};
						},
						update() {},
						wait() {
							return new Promise<void>((resolve) => {
								wake = resolve;
							});
						},
						close() {
							wake();
						},
					},
				},
				() =>
					resolveBuildConfig({
						assets: { public: { type: "directory", path: assets, include: ["**/*"] } },
					}),
			);
			try {
				await completed[0]!.promise;
				writeFileSync(path.join(tests, "two.test.mts"), "export {};\n");
				writeFileSync(path.join(assets, "new.txt"), "new asset\n");
				wake();
				await completed[1]!.promise;
				expect(requests[1]?.input.files).toHaveLength(2);
				expect(requests[1]?.options?.invalidateAll).toBe(true);
				process.emit("SIGHUP");
				await completed[2]!.promise;
				expect(requests).toHaveLength(2);
				expect(applications.launches).toHaveLength(3);
				process.emit("SIGINT");
				wake();
				await running;
				expect(applications.joins).toBe(3);
				expect(applications.releases).toBe(2);
			} finally {
				process.emit("SIGINT");
				wake();
				await running;
				output.mockRestore();
				stderr.mockRestore();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
	it("joins cancellation before releasing an application whose evaluation has not completed", async () => {
		let finish!: (exit: ApplicationExit) => void;
		const closed = new Promise<ApplicationExit>((resolve) => {
			finish = resolve;
		});
		let stopped!: () => void;
		const stopping = new Promise<void>((resolve) => {
			stopped = resolve;
		});
		let releases = 0;
		const host: ApplicationImageHost = {
			load() {
				return {
					launch() {
						return {
							id: 1,
							ready: new Promise(() => {}),
							applicationReady: new Promise(() => {}),
							closed,
							port: {} as ApplicationInstance["port"],
							ref() {},
							unref() {},
							terminate() {
								stopped();
								return closed;
							},
						};
					},
					close() {
						releases++;
					},
				};
			},
		};
		const controller = new AbortController();
		const run = executeTestApplication(
			host,
			{ files: ["one"], image: {} } as PreparedTestApplication,
			{ repeat: 1, bail: false, timeoutMs: 1 },
			{ signal: controller.signal },
		);
		const failed = expect(run).rejects.toThrow("cancel test");
		controller.abort(new Error("cancel test"));
		await stopping;
		expect(releases).toBe(0);
		finish({ id: 1, code: 0, reason: "terminated", hasResult: false });
		await failed;
		expect(releases).toBe(1);
	});
	it("reuses immutable prepared images and seed while launching and joining a fresh application per rerun", async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test-session-"));
		const file = path.join(directory, "one.test.mts");
		writeFileSync(file, "export const revision = 0;\n");
		const applications = applicationHost();
		const requests: Array<TestCompilationInput> = [];
		const command: TestCommand = {
			kind: "test",
			paths: [file],
			shuffle: true,
			nameFilter: "case",
			repeat: 2,
			bail: true,
			timeoutMs: 123,
			compileConcurrency: 1,
			profile: false,
		};
		const context: CommandContext = {
			stripTypes: stripCompactTypes,
			installation: productCompilerInstallation(directory, "compiler", "test"),
			applications: applications.host,
			compiler: {
				prepare: () => Promise.reject(new Error("not application compilation")),
				prepareTests(input) {
					requests.push(input);
					return Promise.resolve(prepared(input));
				},
				close: () => Promise.resolve(),
			},
		};
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const session = createTestApplicationSession(command, context);
		try {
			const first = await executeTestCommand(
				command,
				context,
				resolveBuildConfig({}),
				session,
			);
			const second = await executeTestCommand(
				command,
				context,
				resolveBuildConfig({}),
				session,
			);
			expect(first.passed).toBe(1);
			expect(second.cacheHits).toBe(1);
			expect(second.frontendMs).toBe(0);
			expect(requests).toHaveLength(1);
			expect(applications.loads).toBe(1);
			expect(applications.launches).toHaveLength(2);
			expect(applications.joins).toBe(2);
			expect(applications.launches[0]?.data).toEqual(applications.launches[1]?.data);
			expect(applications.launches[0]?.data).toMatchObject({
				files: [realpathSync(file)],
				repeat: 2,
				bail: true,
				timeoutMs: 123,
				nameFilter: "case",
				shuffleSeed: session.options.shuffleSeed,
			});
			writeFileSync(file, "export const revision = 1;\n");
			await executeTestCommand(command, context, resolveBuildConfig({}), session, {
				invalidatedPaths: [file],
			});
			expect(requests).toHaveLength(2);
			expect(applications.loads).toBe(2);
			expect(applications.releases).toBe(1);
			expect(requests[0]?.execution).toEqual(requests[1]?.execution);
			session.close();
			expect(applications.releases).toBe(2);
			session.close();
			expect(applications.releases).toBe(2);
		} finally {
			session.close();
			output.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("selects failed files dynamically inside the original shared graph without changing static options", async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test-selection-"));
		const files = [
			path.join(directory, "one.test.mts"),
			path.join(directory, "two.test.mts"),
		];
		for (const file of files) writeFileSync(file, "export {};\n");
		const applications = applicationHost((selected, launch) => {
			const current = result(selected);
			if (launch === 1) {
				current.passed--;
				current.failed++;
				current.files[1]!.passed = 0;
				current.files[1]!.failed = 1;
			}
			return current;
		});
		const compiled: Array<TestCompilationInput> = [];
		const command: TestCommand = {
			kind: "test",
			paths: files,
			shuffle: 42,
			nameFilter: "original case",
			repeat: 3,
			bail: false,
			timeoutMs: 88,
			compileConcurrency: 1,
			profile: false,
		};
		const context: CommandContext = {
			stripTypes: stripCompactTypes,
			installation: productCompilerInstallation(directory, "compiler", "test"),
			applications: applications.host,
			compiler: {
				prepare: () => Promise.reject(new Error("unused")),
				prepareTests(input) {
					compiled.push(input);
					return Promise.resolve(prepared(input));
				},
				close: () => Promise.resolve(),
			},
		};
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const session = createTestApplicationSession(command, context);
		try {
			const first = await executeTestCommand(
				command,
				context,
				resolveBuildConfig({}),
				session,
			);
			expect(first.failedFiles).toEqual([realpathSync(files[1]!)]);
			await executeTestCommand(command, context, resolveBuildConfig({}), session, {
				selectedFiles: first.failedFiles,
			});
			expect(applications.loads).toBe(1);
			expect(compiled).toHaveLength(1);
			expect(compiled[0]?.files).toEqual(files.map((file) => realpathSync(file)));
			expect(applications.launches[1]?.data).toEqual({
				files: [realpathSync(files[1]!)],
				shuffleSeed: 42,
				nameFilter: "original case",
				repeat: 3,
				bail: false,
				timeoutMs: 88,
			});
		} finally {
			session.close();
			output.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("bounds independent file compilation and execution at two jobs, joins every isolate, and retains stable compile capacity", async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test-concurrency-"));
		const files = ["one", "two", "three"].map((name) =>
			path.join(directory, `${name}.test.mts`),
		);
		for (const file of files) writeFileSync(file, "export {};\n");
		const compileStarts = channel<{
			input: TestCompilationInput;
			options?: CompilationOptions;
			gate: ReturnType<typeof deferred<PreparedTestApplication>>;
		}>();
		const launchStarts = channel<{
			options: ApplicationLaunchOptions;
			gate: ReturnType<typeof deferred<ApplicationExit>>;
		}>();
		const compileGates: Array<ReturnType<typeof deferred<PreparedTestApplication>>> = [];
		const launchGates: Array<ReturnType<typeof deferred<ApplicationExit>>> = [];
		let compiling = 0;
		let compileMaximum = 0;
		let executing = 0;
		let executionMaximum = 0;
		let joined = 0;
		let released = 0;
		const command: TestCommand = {
			kind: "test",
			paths: files,
			isolation: "file",
			compileConcurrency: 2,
			executionConcurrency: 2,
			repeat: 1,
			bail: false,
			timeoutMs: 88,
			profile: false,
		};
		const context: CommandContext = {
			stripTypes: stripCompactTypes,
			installation: productCompilerInstallation(directory, "compiler", "test"),
			compiler: {
				parallelism: 2,
				prepare: () => Promise.reject(new Error("unused")),
				prepareTests(input, options) {
					const gate = deferred<PreparedTestApplication>();
					compileGates.push(gate);
					compiling++;
					compileMaximum = Math.max(compileMaximum, compiling);
					compileStarts.push({ input, options, gate });
					return gate.promise.finally(() => {
						compiling--;
					});
				},
				close: () => Promise.resolve(),
			},
			applications: {
				load() {
					return {
						launch(options) {
							const gate = deferred<ApplicationExit>();
							launchGates.push(gate);
							const id = launchGates.length;
							executing++;
							executionMaximum = Math.max(executionMaximum, executing);
							const closed = gate.promise.finally(() => {
								executing--;
							});
							launchStarts.push({ options, gate });
							return {
								id,
								ready: Promise.resolve(),
								applicationReady: new Promise(() => {}),
								closed,
								port: {} as ApplicationInstance["port"],
								ref() {},
								unref() {},
								terminate() {
									joined++;
									return closed;
								},
							};
						},
						close() {
							released++;
						},
					};
				},
			},
		};
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const running = executeTestCommand(command, context, resolveBuildConfig({}));
		const finish = (request: {
			options: ApplicationLaunchOptions;
			gate: ReturnType<typeof deferred<ApplicationExit>>;
		}) =>
			request.gate.resolve({
				id: 1,
				code: 0,
				reason: "completed",
				hasResult: true,
				result: result((request.options.data as TestRunOptions).files!),
			});
		try {
			const first = await compileStarts.next();
			const second = await compileStarts.next();
			expect(compileGates).toHaveLength(2);
			expect(first.input.files).toHaveLength(1);
			expect(first.options?.concurrency).toBe(2);
			first.gate.resolve(prepared(first.input));
			const third = await compileStarts.next();
			expect(compileMaximum).toBe(2);
			second.gate.resolve(prepared(second.input));
			third.gate.resolve(prepared(third.input));
			const launchOne = await launchStarts.next();
			const launchTwo = await launchStarts.next();
			expect(launchGates).toHaveLength(2);
			finish(launchOne);
			const launchThree = await launchStarts.next();
			finish(launchTwo);
			finish(launchThree);
			expect(await running).toMatchObject({ passed: 3, failed: 0 });
			expect(executionMaximum).toBe(2);
			expect(executing).toBe(0);
			expect(joined).toBe(3);
			expect(released).toBe(3);
			command.paths = [files[0]!];
			const single = executeTestCommand(command, context, resolveBuildConfig({}));
			const last = await compileStarts.next();
			expect(last.options?.concurrency).toBe(2);
			last.gate.resolve(prepared(last.input));
			finish(await launchStarts.next());
			expect(await single).toMatchObject({ passed: 1, failed: 0 });
		} finally {
			for (const gate of compileGates)
				gate.resolve(prepared({ files: [] } as unknown as TestCompilationInput));
			for (const gate of launchGates)
				gate.resolve({ id: 1, code: 0, reason: "terminated", hasResult: false });
			await running.catch(() => {});
			output.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("discards buffered reports for superseded execution", async () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-test-stale-"));
		const file = path.join(directory, "one.test.mts");
		writeFileSync(file, "export {};\n");
		const applications = applicationHost();
		const command: TestCommand = {
			kind: "test",
			paths: [file],
			repeat: 1,
			bail: false,
			timeoutMs: 88,
			compileConcurrency: 1,
			profile: false,
		};
		const context: CommandContext = {
			stripTypes: stripCompactTypes,
			installation: productCompilerInstallation(directory, "compiler", "test"),
			applications: applications.host,
			compiler: {
				prepare: () => Promise.reject(new Error("unused")),
				prepareTests: (input) => Promise.resolve(prepared(input)),
				close: () => Promise.resolve(),
			},
		};
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await executeTestCommand(command, context, resolveBuildConfig({}), undefined, {
				isCurrent: () => false,
			});
			expect(output).not.toHaveBeenCalled();
			expect(applications.releases).toBe(1);
		} finally {
			output.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects dynamic file selection outside its compiled graph before loading", async () => {
		const applications = applicationHost();
		await expect(
			executeTestApplication(
				applications.host,
				{ files: ["one"] } as PreparedTestApplication,
				{ files: ["other"], repeat: 1, bail: false, timeoutMs: 1 },
			),
		).rejects.toThrow("outside the compiled application");
		expect(applications.loads).toBe(0);
	});
});
