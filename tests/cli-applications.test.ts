import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	ApplicationExit,
	ApplicationImageDescriptor,
	ApplicationInstance,
	ApplicationLaunchOptions,
} from "../src/application-images.ts";
import {
	devCommand,
	prepareCommand,
	productCompilerInstallation,
	runCommand,
} from "../src/cli-commands.ts";
import type { BuildCommandResult } from "../src/cli-commands.ts";
import type { CompilationOptions } from "../src/compiler-service.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { FrontendCompilationSession } from "../src/frontend-cache.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function channel<T>() {
	const unread: Array<T> = [];
	const waiters: Array<(value: T) => void> = [];
	return {
		push(value: T) {
			const waiter = waiters.shift();
			if (waiter === undefined) unread.push(value);
			else waiter(value);
		},
		next(): Promise<T> {
			const value = unread.shift();
			return value === undefined
				? new Promise((resolve) => {
						waiters.push(resolve);
					})
				: Promise.resolve(value);
		},
	};
}

function descriptor(entryPath: string): ApplicationImageDescriptor {
	return {
		schema: 1,
		wires: [{ path: "app.malw", sha256: "digest" }],
		entryPath,
		node: true,
		webPlatform: true,
		engine: {
			primordials: "locked",
			eval: true,
			realms: true,
			regexp: true,
			temporal: false,
			intl: false,
		},
	};
}

function imageHarness() {
	type Launch = {
		image: ApplicationImageDescriptor;
		options: ApplicationLaunchOptions;
		evaluated: ReturnType<typeof deferred<void>>;
		ready: ReturnType<typeof deferred<void>>;
		exit: ReturnType<typeof deferred<ApplicationExit>>;
		stop: ReturnType<typeof deferred<ApplicationExit>>;
		terminating: ReturnType<typeof deferred<void>>;
		terminationStarted: boolean;
	};
	const launches = channel<Launch>();
	const released: Array<ApplicationImageDescriptor> = [];
	let id = 0;
	return {
		launches,
		released,
		host: {
			load(image: ApplicationImageDescriptor) {
				return {
					launch(options: ApplicationLaunchOptions): ApplicationInstance {
						const evaluated = deferred<void>();
						const ready = deferred<void>();
						const exit = deferred<ApplicationExit>();
						const stop = deferred<ApplicationExit>();
						const terminating = deferred<void>();
						const launch = {
							image,
							options,
							evaluated,
							ready,
							exit,
							stop,
							terminating,
							terminationStarted: false,
						};
						launches.push(launch);
						return {
							id: ++id,
							ready: evaluated.promise,
							applicationReady: ready.promise,
							closed: exit.promise,
							port: {} as ApplicationInstance["port"],
							ref() {},
							unref() {},
							terminate() {
								launch.terminationStarted = true;
								terminating.resolve();
								return stop.promise;
							},
						};
					},
					close() {
						released.push(image);
					},
				};
			},
		},
	};
}

const completed: ApplicationExit = {
	id: 1,
	code: 7,
	reason: "completed",
	hasResult: false,
};

describe("CLI application images", () => {
	it("closes the watcher and removes signal ownership when the initial session observer throws", async () => {
		const failure = new Error("initial session observer failed");
		const images = imageHarness();
		const signalCounts = [
			process.listenerCount("SIGINT"),
			process.listenerCount("SIGTERM"),
		];
		let watchedClosed = false;
		let admitted = false;
		let threw = false;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
			if (String(text).startsWith("Session ") && !threw) {
				threw = true;
				throw failure;
			}
			return true;
		});
		try {
			await expect(
				devCommand(
					{
						kind: "dev",
						entry: "/app.mts",
						status: true,
						verbose: false,
						profile: false,
						programArgs: [],
					},
					{
						stripTypes: stripCompactTypes,
						installation: productCompilerInstallation("/runtime", "compiler", "test"),
						applications: images.host,
						compiler: {
							prepare() {
								admitted = true;
								return Promise.reject(new Error("unused"));
							},
							close: () => Promise.resolve(),
						},
						developmentWatcher: {
							create: () => ({}),
							update() {},
							wait: () => Promise.resolve(),
							close() {
								watchedClosed = true;
							},
						},
					},
				),
			).rejects.toBe(failure);
			expect(watchedClosed).toBe(true);
			expect(admitted).toBe(false);
			expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(
				signalCounts,
			);
		} finally {
			stderr.mockRestore();
		}
	});
	it("prepares digest-identified images only for an in-process compatible runner", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-image-descriptor-"));
		try {
			const entry = path.join(directory, "entry.mts");
			const config = path.join(directory, "maligator.build.mts");
			writeFileSync(entry, "console.log(42);\n");
			writeFileSync(
				config,
				"export default { surface: { node: false, webPlatform: false }, engine: { eval: 'compile-check', realms: false, regexp: false, temporal: false, intl: { enabled: false } } };\n",
			);
			const context = {
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					directory,
					"compiler.malw",
					"test.mjs",
					undefined,
					"/runner",
				),
			};
			const command = {
				kind: "run" as const,
				entry,
				configPath: config,
				verbose: false,
				profile: false,
				programArgs: [],
			};
			const prepared = prepareCommand(command, context);
			expect(prepared.applicationImage).toMatchObject({
				schema: 1,
				entryPath: entry,
				node: false,
				webPlatform: false,
				engine: { eval: false, temporal: false },
			});
			expect(prepared.applicationImage?.wires).toHaveLength(1);
			expect(prepared.applicationImage?.wires[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(prepared.applicationImage?.workerManifestPath).toBeUndefined();
			context.installation.developmentRunners![0]!.inProcess = false;
			expect(prepareCommand(command, context).applicationImage).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("waits for evaluation and joined exit, preserves argv, and releases even completed images", async () => {
		const images = imageHarness();
		const image = descriptor("/app.mts");
		const run = runCommand(
			{
				kind: "run",
				verbose: false,
				profile: false,
				programArgs: ["two words", "--flag"],
			},
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					"/runtime",
					"/compiler.malw",
					"/test.mjs",
				),
				compiler: {
					prepare: () =>
						Promise.resolve({ binaryPath: "/maligator", applicationImage: image }),
					close: () => Promise.resolve(),
				},
				applications: images.host,
			},
		);
		const launch = await images.launches.next();
		expect(launch.options.argv).toEqual([
			"/maligator",
			"/app.mts",
			"two words",
			"--flag",
		]);
		let finished = false;
		void run.then(() => {
			finished = true;
		});
		launch.exit.resolve(completed);
		await Promise.resolve();
		expect(finished).toBe(false);
		launch.evaluated.resolve();
		await launch.terminating.promise;
		expect(images.released).toEqual([]);
		launch.stop.resolve(completed);
		expect(await run).toEqual({ status: 7, applicationExit: completed });
		expect(images.released).toEqual([image]);
	});

	it("terminates and releases an image when evaluation fails", async () => {
		const images = imageHarness();
		const image = descriptor("/broken.mts");
		const run = runCommand(
			{ kind: "run", verbose: false, profile: false, programArgs: [] },
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					"/runtime",
					"/compiler.malw",
					"/test.mjs",
				),
				compiler: {
					prepare: () =>
						Promise.resolve({ binaryPath: "/maligator", applicationImage: image }),
					close: () => Promise.resolve(),
				},
				applications: images.host,
			},
		);
		const assertion = expect(run).rejects.toThrow("evaluation failed");
		const launch = await images.launches.next();
		launch.evaluated.reject(new Error("evaluation failed"));
		await launch.terminating.promise;
		launch.exit.resolve(completed);
		launch.stop.resolve(completed);
		await assertion;
		expect(images.released).toEqual([image]);
	});

	it("joins and releases the image even if terminate reports a failure", async () => {
		const images = imageHarness();
		const image = descriptor("/app.mts");
		const run = runCommand(
			{ kind: "run", verbose: false, profile: false, programArgs: [] },
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(
					"/runtime",
					"/compiler.malw",
					"/test.mjs",
				),
				compiler: {
					prepare: () =>
						Promise.resolve({ binaryPath: "/maligator", applicationImage: image }),
					close: () => Promise.resolve(),
				},
				applications: images.host,
			},
		);
		const assertion = expect(run).rejects.toThrow("termination failed");
		const launch = await images.launches.next();
		launch.evaluated.resolve();
		launch.exit.resolve(completed);
		await launch.terminating.promise;
		launch.stop.reject(new Error("termination failed"));
		await assertion;
		expect(images.released).toEqual([image]);
	});

	it.each([
		{
			name: "watches newly discovered files during old-image shutdown and never activates their stale revision",
			restoreOutcome: "evaluate",
		},
		{
			name: "stops and joins a restored last-good application while its evaluation remains pending",
			restoreOutcome: "shutdown",
		},
		{
			name: "advances newer compilation during pending restoration and ignores its late evaluation rejection",
			restoreOutcome: "supersede",
		},
		{
			name: "reports current restoration evaluation failure once and joins it before replacement",
			restoreOutcome: "failure",
		},
		{
			name: "drains admitted compilation and restored images before reporting watcher close failure",
			restoreOutcome: "watch-close-failure",
		},
		{
			name: "retains a newer application while deferred natural-exit cleanup joins the old instance",
			restoreOutcome: "natural-exit",
		},
	])("$name", async ({ restoreOutcome }) => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-image-race-"));
		const entry = path.join(directory, "entry.mts");
		const leaf = path.join(directory, "leaf.mts");
		writeFileSync(entry, "export const revision = 0;\n");
		writeFileSync(leaf, "export const value = 0;\n");
		const images = imageHarness();
		const requests = channel<{
			result: ReturnType<typeof deferred<BuildCommandResult>>;
			options: CompilationOptions;
		}>();
		const active = channel<number>();
		const activeGenerations: Array<number> = [];
		const applicationStates: Array<{ generation: number; state: string }> = [];
		const messages: Array<string> = [];
		const watcherClosed = deferred<void>();
		const naturalExitObserved = deferred<void>();
		const watcherFailure = new Error("watcher close failed");
		let compilations = 0;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
			const line = String(text);
			messages.push(line);
			if (line.startsWith("Application ") && line.includes("waiting for changes."))
				naturalExitObserved.resolve();
			if (line.startsWith("Session ")) {
				const snapshot = JSON.parse(line.slice(8)) as {
					phase: string;
					activeGeneration?: number;
					application?: { generation: number; state: string };
				};
				if (snapshot.application !== undefined)
					applicationStates.push(snapshot.application);
				if (snapshot.phase === "active" && snapshot.activeGeneration !== undefined) {
					activeGenerations.push(snapshot.activeGeneration);
					active.push(snapshot.activeGeneration);
				}
			}
			return true;
		});
		let wake = () => {};
		const watched: Array<Array<string>> = [];
		const dev = devCommand(
			{
				kind: "dev",
				entry,
				verbose: false,
				status: true,
				profile: false,
				programArgs: [],
			},
			{
				stripTypes: stripCompactTypes,
				installation: productCompilerInstallation(directory, "compiler.malw", "test.mjs"),
				applications: images.host,
				compiler: {
					prepare(_command, options: CompilationOptions = {}) {
						compilations++;
						const result = deferred<BuildCommandResult>();
						requests.push({ result, options });
						return result.promise;
					},
					close: () => Promise.resolve(),
				},
				developmentWatcher: {
					create(files) {
						watched.push(files);
						return {};
					},
					update(_handle, files) {
						watched.push(files);
					},
					wait() {
						return new Promise<void>((resolve) => {
							wake = resolve;
						});
					},
					close() {
						wake();
						watcherClosed.resolve();
						if (restoreOutcome === "watch-close-failure") throw watcherFailure;
					},
				},
			},
		);
		try {
			const lastGood = descriptor(entry);
			(await requests.next()).result.resolve({
				binaryPath: "/maligator",
				applicationImage: lastGood,
				dependencies: [entry],
			});
			const original = await images.launches.next();
			original.evaluated.resolve();
			expect(await active.next()).toBe(1);
			writeFileSync(entry, "export const revision = 1;\n");
			wake();
			const next = await requests.next();
			const identity = new FrontendCompilationSession().snapshot(leaf);
			const stale = descriptor("stale");
			next.result.resolve({
				binaryPath: "/maligator",
				applicationImage: stale,
				dependencies: [entry, leaf],
				dependencyIdentities: [
					identity,
					...(restoreOutcome === "natural-exit"
						? [new FrontendCompilationSession().snapshot(entry)]
						: []),
				],
			});
			await original.terminating.promise;
			expect(watched.at(-1)).toContain(leaf);
			if (restoreOutcome === "natural-exit") {
				original.exit.resolve(completed);
				await new Promise<void>((resolve) => {
					setImmediate(resolve);
				});
				wake();
				await naturalExitObserved.promise;
				original.stop.resolve(completed);
				const latest = await images.launches.next();
				latest.evaluated.resolve();
				expect(await active.next()).toBe(2);
				process.emit("SIGINT");
				wake();
				await latest.terminating.promise;
				latest.stop.resolve(completed);
				latest.exit.resolve(completed);
				await dev;
				expect(images.released).toEqual([lastGood, stale]);
				return;
			}
			writeFileSync(leaf, "export const value = 1;\n");
			original.stop.resolve(completed);
			original.exit.resolve(completed);
			const restored = await images.launches.next();
			expect(restored.image).toBe(lastGood);
			const newest = await requests.next();
			if (restoreOutcome === "shutdown" || restoreOutcome === "watch-close-failure") {
				let finished = false;
				const settled = dev.then(
					() => {
						finished = true;
					},
					(error: unknown) => {
						finished = true;
						throw error;
					},
				);
				const assertion =
					restoreOutcome === "watch-close-failure"
						? expect(settled).rejects.toBe(watcherFailure)
						: settled;
				process.emit("SIGINT");
				wake();
				await watcherClosed.promise;
				await new Promise<void>((resolve) => {
					setImmediate(resolve);
				});
				expect(newest.options.signal?.aborted).toBe(true);
				expect(finished).toBe(false);
				newest.result.resolve({ binaryPath: "cancelled" });
				await restored.terminating.promise;
				expect(finished).toBe(false);
				expect(images.released).toEqual([lastGood]);
				restored.stop.resolve(completed);
				restored.exit.resolve(completed);
				await assertion;
				expect(finished).toBe(true);
				expect(compilations).toBe(3);
				expect(activeGenerations).not.toContain(2);
				expect(activeGenerations).not.toContain(3);
				expect(images.released).toEqual([lastGood, lastGood]);
				return;
			}
			if (restoreOutcome === "evaluate") restored.evaluated.resolve();
			if (restoreOutcome === "failure") {
				restored.evaluated.reject(new Error("restoration failed"));
				await restored.terminating.promise;
			}
			const current = descriptor("current");
			newest.result.resolve({
				binaryPath: "/maligator",
				applicationImage: current,
				dependencies: [entry, leaf],
				dependencyIdentities: [new FrontendCompilationSession().snapshot(leaf)],
			});
			await restored.terminating.promise;
			restored.stop.resolve(completed);
			restored.exit.resolve(completed);
			const latest = await images.launches.next();
			expect(latest.image).toBe(current);
			latest.evaluated.resolve();
			if (restoreOutcome === "supersede") {
				expect(await active.next()).toBe(3);
				restored.evaluated.reject(new Error("superseded restoration"));
				await new Promise<void>((resolve) => {
					setImmediate(resolve);
				});
				expect(latest.terminationStarted).toBe(false);
				expect(applicationStates.at(-1)).toMatchObject({
					generation: 3,
					state: "evaluated",
				});
				expect(messages.join("")).not.toContain("superseded restoration");
			}
			if (restoreOutcome === "failure") {
				expect(await active.next()).toBe(3);
				expect(
					messages.filter((message) =>
						message.startsWith("Application restoration failed"),
					),
				).toEqual([
					"Application restoration failed for generation 1: restoration failed\n",
				]);
			}
			process.emit("SIGINT");
			wake();
			await latest.terminating.promise;
			latest.stop.resolve(completed);
			latest.exit.resolve(completed);
			await dev;
			expect(images.released).toEqual([lastGood, lastGood, current]);
		} finally {
			stderr.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
