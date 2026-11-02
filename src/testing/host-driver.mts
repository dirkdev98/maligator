import { connect } from "node:net";
import type {
	ApplicationInstance,
	NativeApplicationBridge,
} from "../application-images.ts";
import { TEST_HOST_MESSAGE_LIMIT, testHostError } from "./host-protocol.mts";
import type { TestHostEvent, TestHostRequest } from "./host-protocol.mts";

const bridge = Reflect.get(globalThis, "mal") as unknown as NativeApplicationBridge;
const images = new Map<number, object>();
const applications = new Map<
	number,
	{ application: ApplicationInstance; notices: Promise<void> }
>();
const socket = connect(Number(process.argv[2]), "127.0.0.1");
let closing: Promise<void> | undefined;
let finish!: () => void;
let fail!: (error: Error) => void;
const lifetime = new Promise<void>((resolve, reject) => {
	finish = resolve;
	fail = reject;
});

function send(message: TestHostEvent): void {
	const line = `${JSON.stringify({ ...message, resources: bridge._applicationResources() })}\n`;
	if (Buffer.byteLength(line) > TEST_HOST_MESSAGE_LIMIT)
		throw new Error("test host response exceeds the control message limit");
	socket.write(line);
}

function stop(): Promise<void> {
	return (closing ??= (async () => {
		const failures: Array<unknown> = [];
		for (const { application, notices } of applications.values()) {
			try {
				await application.terminate();
				await application.closed;
				await notices;
			} catch (error) {
				failures.push(error);
			}
		}
		applications.clear();
		for (const image of images.values()) {
			try {
				bridge._releaseApplicationImage(image);
			} catch (error) {
				failures.push(error);
			}
		}
		images.clear();
		if (failures.length > 0)
			throw new AggregateError(failures, "linked test host cleanup failed");
	})());
}

async function handle(request: TestHostRequest): Promise<void> {
	try {
		if (closing !== undefined && request.kind !== "close")
			throw new Error("linked test host is closing");
		switch (request.kind) {
			case "ping":
				break;
			case "load": {
				if (images.has(request.image))
					throw new Error("test image identity is already loaded");
				images.set(request.image, bridge._loadApplicationImage(request.descriptor));
				break;
			}
			case "launch": {
				const image = images.get(request.image);
				if (image === undefined || applications.has(request.application))
					throw new Error("invalid linked test launch identity");
				const application = bridge._launchApplicationImage(image, request.options);
				const ready = application.ready.then(
					() => send({ kind: "ready", application: request.application }),
					(error: unknown) =>
						send({
							kind: "ready",
							application: request.application,
							error: testHostError(error),
						}),
				);
				const applicationReady = application.applicationReady.then(
					() => send({ kind: "application-ready", application: request.application }),
					(error: unknown) =>
						send({
							kind: "application-ready",
							application: request.application,
							error: testHostError(error),
						}),
				);
				const closed = application.closed.then(({ error, ...exit }) =>
					send({
						kind: "closed",
						application: request.application,
						exit: {
							...exit,
							...(error === undefined ? {} : { error: testHostError(error) }),
						},
					}),
				);
				const notices = Promise.all([ready, applicationReady, closed]).then(() => {});
				void notices.catch(fail);
				applications.set(request.application, { application, notices });
				break;
			}
			case "release": {
				const image = images.get(request.image);
				if (image === undefined) throw new Error("test image is not loaded");
				bridge._releaseApplicationImage(image);
				images.delete(request.image);
				break;
			}
			case "terminate": {
				const entry = applications.get(request.application);
				if (entry === undefined) throw new Error("test application is not running");
				const { application, notices } = entry;
				await application.terminate();
				await application.closed;
				await notices;
				applications.delete(request.application);
				break;
			}
			case "close":
				await stop();
				break;
		}
		send({ kind: "reply", id: request.id });
		if (request.kind === "close") {
			socket.end();
			finish();
		}
	} catch (error) {
		send({ kind: "reply", id: request.id, error: testHostError(error) });
		if (request.kind === "close") {
			socket.end();
			fail(new Error("linked test host cleanup failed"));
		}
	}
}

socket.setEncoding("utf8");
socket.once("connect", () =>
	socket.write(`${JSON.stringify({ kind: "hello", token: process.argv[3] })}\n`),
);
let pending = "";
socket.on("data", (chunk: string) => {
	try {
		pending += chunk;
		for (;;) {
			const end = pending.indexOf("\n");
			if (end < 0) break;
			if (Buffer.byteLength(pending.slice(0, end)) > TEST_HOST_MESSAGE_LIMIT)
				throw new Error("test host request exceeds the control message limit");
			const request = JSON.parse(pending.slice(0, end)) as TestHostRequest;
			pending = pending.slice(end + 1);
			void handle(request).catch(fail);
		}
		if (Buffer.byteLength(pending) > TEST_HOST_MESSAGE_LIMIT)
			throw new Error("test host request exceeds the control message limit");
	} catch (error) {
		fail(error instanceof Error ? error : new Error(String(error)));
	}
});
socket.once("error", fail);
socket.once("close", () => {
	if (closing === undefined) fail(new Error("linked test supervisor disconnected"));
});

try {
	await lifetime;
} finally {
	await stop();
	socket.destroy();
}
