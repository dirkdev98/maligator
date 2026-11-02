import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import type { ApplicationExit, ApplicationResources } from "../application-images.ts";
import type { TestApplication, TestApplicationHost } from "./application-host.ts";
import { restoreTestHostError, TEST_HOST_MESSAGE_LIMIT } from "./host-protocol.mts";
import type { TestHostMessage, TestHostOperation } from "./host-protocol.mts";

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Value>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	void promise.catch(() => {});
	return { promise, resolve, reject };
}

export interface LinkedTestHost extends TestApplicationHost {
	readonly pid: number;
	readonly alive: boolean;
	check(): Promise<void>;
	close(): Promise<void>;
}

/** A persistent native host owns image references and joins every launched application. */
export async function startLinkedTestHost(options: {
	executable: string;
	wires: Array<string>;
	entry: string;
	signal?: AbortSignal;
}): Promise<LinkedTestHost> {
	options.signal?.throwIfAborted();
	const token = randomUUID();
	const accepted = deferred<Socket>();
	const server = createServer((candidate) => {
		candidate.setEncoding("utf8");
		let greeting = "";
		const receive = (chunk: string) => {
			greeting += chunk;
			const end = greeting.indexOf("\n");
			if (end < 0 && greeting.length < 1024) return;
			candidate.removeListener("data", receive);
			try {
				const message = JSON.parse(greeting.slice(0, end)) as {
					kind?: string;
					token?: string;
				};
				if (end < 0 || message.kind !== "hello" || message.token !== token)
					throw new Error("invalid linked test host greeting");
				candidate.pause();
				server.close();
				accepted.resolve(candidate);
			} catch {
				candidate.destroy();
			}
		};
		candidate.on("data", receive);
		candidate.on("error", () => candidate.destroy());
	});
	const listening = deferred<void>();
	server.once("error", (error) => {
		listening.reject(error);
		accepted.reject(error);
	});
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("linked test supervisor needs a loopback address");
	}
	const child = spawn(
		options.executable,
		[
			"--maligator-internal-run-wires",
			String(options.wires.length),
			options.entry,
			...options.wires,
			String(address.port),
			token,
		],
		{ stdio: "inherit", detached: true },
	);
	const exited = deferred<void>();
	let processFailure: Error | undefined;
	let stopping = false;
	const processStopped = (error?: Error) => {
		processFailure = error;
		if (error !== undefined) accepted.reject(error);
		exited.resolve();
	};
	child.once("error", (error) => processStopped(error));
	child.once("close", (code, signal) =>
		processStopped(
			stopping && code === 0
				? undefined
				: new Error(`linked test host exited with ${signal ?? `code ${String(code)}`}`),
		),
	);
	const abort = () => {
		accepted.reject(new Error("linked test host startup canceled"));
		child.kill("SIGKILL");
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	let socket: Socket;
	try {
		socket = await accepted.promise;
	} catch (error) {
		server.close();
		child.kill("SIGKILL");
		await exited.promise;
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", abort);
	}

	let resources: ApplicationResources = {
		loadedImages: 0,
		runningApplications: 0,
		ownedWorkers: 0,
		processWorkers: 0,
		processImageDomains: 0,
		processWorkerWireBytes: 0,
	};
	let requestId = 0;
	let objectId = 0;
	let failure: Error | undefined;
	let closing: Promise<void> | undefined;
	const requests = new Map<number, ReturnType<typeof deferred<void>>>();
	const applications = new Map<
		number,
		{
			ready: ReturnType<typeof deferred<void>>;
			applicationReady: ReturnType<typeof deferred<void>>;
			closed: ReturnType<typeof deferred<ApplicationExit>>;
		}
	>();
	const fail = (error: Error) => {
		failure ??= error;
		for (const pending of requests.values()) pending.reject(error);
		requests.clear();
		for (const application of applications.values()) {
			application.ready.reject(error);
			application.applicationReady.reject(error);
			application.closed.reject(error);
		}
		applications.clear();
	};
	const request = (message: TestHostOperation): Promise<void> => {
		if (failure !== undefined) return Promise.reject(failure);
		const pending = deferred<void>();
		const id = ++requestId;
		requests.set(id, pending);
		try {
			const line = `${JSON.stringify({ ...message, id })}\n`;
			if (Buffer.byteLength(line) > TEST_HOST_MESSAGE_LIMIT)
				throw new Error("test host request exceeds the control message limit");
			socket.write(line);
		} catch (error) {
			requests.delete(id);
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return pending.promise;
	};
	let pending = "";
	socket.on("data", (chunk: string) => {
		try {
			pending += chunk;
			for (;;) {
				const end = pending.indexOf("\n");
				if (end < 0) break;
				if (Buffer.byteLength(pending.slice(0, end)) > TEST_HOST_MESSAGE_LIMIT)
					throw new Error("test host response exceeds the control message limit");
				const message = JSON.parse(pending.slice(0, end)) as TestHostMessage;
				pending = pending.slice(end + 1);
				resources = message.resources;
				if (message.kind === "reply") {
					const response = requests.get(message.id);
					if (response === undefined)
						throw new Error("unexpected linked test host reply");
					requests.delete(message.id);
					if (message.error !== undefined)
						response.reject(restoreTestHostError(message.error));
					else response.resolve();
				} else {
					const application = applications.get(message.application);
					if (application === undefined)
						throw new Error("unexpected linked test application event");
					if (message.kind === "closed")
						application.closed.resolve({
							...message.exit,
							...(message.exit.error === undefined
								? {}
								: { error: restoreTestHostError(message.exit.error) }),
						});
					else {
						const ready =
							message.kind === "ready" ? application.ready : application.applicationReady;
						if (message.error === undefined) ready.resolve();
						else ready.reject(restoreTestHostError(message.error));
					}
				}
			}
			if (Buffer.byteLength(pending) > TEST_HOST_MESSAGE_LIMIT)
				throw new Error("test host response exceeds the control message limit");
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
			socket.destroy();
		}
	});
	socket.once("error", fail);
	socket.once("close", () => {
		if (!stopping || requests.size > 0)
			fail(new Error("linked test host control connection closed"));
	});
	void exited.promise.then(() => {
		if (processFailure !== undefined) fail(processFailure);
	});
	if (processFailure !== undefined) fail(processFailure);
	else if (socket.destroyed)
		fail(new Error("linked test host control connection closed during startup"));
	socket.resume();
	return {
		pid: child.pid!,
		check: () => request({ kind: "ping" }),
		get alive() {
			return (
				!stopping &&
				failure === undefined &&
				child.exitCode === null &&
				child.signalCode === null
			);
		},
		resources: () => ({ ...resources }),
		load(descriptor) {
			if (stopping) throw new Error("linked test host is closing");
			const image = ++objectId;
			const loaded = request({ kind: "load", image, descriptor });
			void loaded.catch(() => {});
			let released = false;
			return {
				launch(launchOptions): TestApplication {
					if (released || stopping) throw new Error("linked test image is closed");
					const application = ++objectId;
					const state = {
						ready: deferred<void>(),
						applicationReady: deferred<void>(),
						closed: deferred<ApplicationExit>(),
					};
					applications.set(application, state);
					const launched = loaded.then(() =>
						request({ kind: "launch", image, application, options: launchOptions }),
					);
					void launched.catch((error: unknown) => {
						const reason = error instanceof Error ? error : new Error(String(error));
						state.ready.reject(reason);
						state.applicationReady.reject(reason);
						state.closed.reject(reason);
						applications.delete(application);
					});
					let termination: Promise<ApplicationExit> | undefined;
					return {
						ready: state.ready.promise,
						applicationReady: state.applicationReady.promise,
						closed: state.closed.promise,
						terminate() {
							return (termination ??= launched.then(async () => {
								await request({ kind: "terminate", application });
								const exit = await state.closed.promise;
								applications.delete(application);
								return exit;
							}));
						},
					};
				},
				close() {
					if (released) return;
					released = true;
					if (!stopping)
						void loaded.then(() => request({ kind: "release", image })).catch(fail);
				},
			};
		},
		close() {
			return (closing ??= (async () => {
				stopping = true;
				try {
					await Promise.resolve();
					while (requests.size > 0)
						await Promise.all([...requests.values()].map((pending) => pending.promise));
					await request({ kind: "close" });
					await exited.promise;
					if (failure !== undefined) throw failure;
					if (processFailure !== undefined) throw processFailure;
				} finally {
					socket.destroy();
					server.close();
					await exited.promise;
				}
			})());
		},
	};
}
