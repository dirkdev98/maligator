import type { FixtureBridge } from "./types.ts";
const bridge = mal as unknown as FixtureBridge;
import { readFileSync, unlinkSync } from "node:fs";
import process from "node:process";
import { ready } from "maligator:application";
import { Worker } from "maligator:workers";
import type { ApplicationImageDescriptor } from "../../../src/application-images.ts";
import type { ApplicationResult, ChildResult } from "./types.ts";
function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function scopedResources(
	loadedImages: number,
	runningApplications: number,
	ownedWorkers: number,
) {
	const resources = bridge._applicationResources();
	check(resources.loadedImages === loadedImages, "open image handle count");
	check(resources.runningApplications === runningApplications, "owned application count");
	check(resources.ownedWorkers === ownedWorkers, "owned ordinary worker count");
	return resources;
}
check(ready() === false, "standalone readiness returns false");
const initialResources = scopedResources(0, 0, 0);
check(
	initialResources.processWorkers === 0 &&
		initialResources.processImageDomains === 0 &&
		initialResources.processWorkerWireBytes === 0,
	"initial process counts",
);
const descriptors = process.argv
	.slice(2)
	.map(
		(filename) =>
			JSON.parse(readFileSync(filename, "utf8")) as ApplicationImageDescriptor,
	);
const [first, second, unresolvedDescriptor, nodeOnly] = descriptors;
check(first && second && unresolvedDescriptor && nodeOnly, "four fixture descriptors");
function rejected(callback: () => unknown, message: string) {
	let threw = false;
	try {
		callback();
	} catch {
		threw = true;
	}
	check(threw, message);
}
rejected(
	() =>
		bridge._loadApplicationImage({
			...first,
			engine: { ...first.engine, primordials: "mutable" },
		}),
	"policy rejected",
);
rejected(
	() =>
		bridge._loadApplicationImage({ ...first, engine: { ...first.engine, intl: true } }),
	"capability rejected",
);
rejected(
	() =>
		bridge._loadApplicationImage({
			...first,
			wires: [{ path: first.wires[0]!.path, sha256: "0".repeat(64) }],
		}),
	"digest rejected",
);
rejected(
	() =>
		bridge._loadApplicationImage({
			...first,
			wires: [{ path: "/missing-image.malw", sha256: first.wires[0]!.sha256 }],
		}),
	"missing artifact rejected",
);
rejected(
	() => bridge._launchApplicationImage({}, { argv: [] }),
	"opaque handle identity",
);
function load(descriptor: ApplicationImageDescriptor) {
	return bridge._loadApplicationImage(descriptor);
}
function launch(handle: object, mode = "normal", gate = new SharedArrayBuffer(4)) {
	if (mode !== "gated") Atomics.store(new Int32Array(gate), 0, 1);
	return bridge._launchApplicationImage(handle, {
		argv: ["application-host", first!.entryPath, "argument with spaces", "tail"],
		data: { mode, nested: [1, 2], gate },
		exitOnResult: true,
	});
}
const unresolvedHandle = load(unresolvedDescriptor);
const unresolvedExit = await launch(unresolvedHandle, "unresolved").closed;
check(
	unresolvedExit.reason === "error" &&
		(unresolvedExit.error as Error).message.includes("unresolved top-level await"),
	"unresolved TLA failure",
);
bridge._releaseApplicationImage(unresolvedHandle);
scopedResources(0, 0, 0);
const nodeOnlyHandle = load(nodeOnly);
const nodeOnlyExit = await launch(nodeOnlyHandle).closed;
check(
	nodeOnlyExit.reason === "completed" &&
		(nodeOnlyExit.result as { answer: number }).answer === 42,
	`Node-only fetch uses fresh stream globals: ${(nodeOnlyExit.error as Error | undefined)?.stack || JSON.stringify(nodeOnlyExit)}`,
);
bridge._releaseApplicationImage(nodeOnlyHandle);
scopedResources(0, 0, 0);
const a = load(first);
const b = load(second);
const loadedResources = scopedResources(2, 0, 0);
check(
	loadedResources.processImageDomains === 2 && loadedResources.processWorkerWireBytes > 0,
	"loaded worker domain ownership",
);
for (const descriptor of [first, second]) {
	for (const entry of (
		JSON.parse(readFileSync(descriptor.workerManifestPath!, "utf8")) as {
			entries: Array<{ wirePath: string }>;
		}
	).entries)
		unlinkSync(entry.wirePath);
	unlinkSync(
		descriptor.assetManifestPath!.replace("assets-", "asset-").replace(".mala", ".txt"),
	);
}
for (const descriptor of descriptors)
	for (const wire of descriptor.wires) unlinkSync(wire.path);
const startupGate = new SharedArrayBuffer(4);
const one = launch(a, "gated", startupGate);
const secondGate = new SharedArrayBuffer(4);
const two = launch(b, "gated", secondGate);
bridge._releaseApplicationImage(b);
bridge._releaseApplicationImage(b);
rejected(() => launch(b), "closed handle rejected");
await Promise.all([one.ready, two.ready]);
const concurrentResources = scopedResources(1, 2, 0);
check(
	concurrentResources.processWorkers === 4,
	"two app roots and two descendant workers",
);
check(
	concurrentResources.processImageDomains === 2 &&
		concurrentResources.processWorkerWireBytes === loadedResources.processWorkerWireBytes,
	"launches share retained worker bytes",
);
let signaled = false;
void one.applicationReady.then(() => {
	signaled = true;
});
await Promise.resolve();
await Promise.resolve();
check(!signaled, "evaluation precedes gated application readiness");
Atomics.store(new Int32Array(startupGate), 0, 1);
Atomics.store(new Int32Array(secondGate), 0, 1);
await one.applicationReady;
check(signaled, "application readiness observed");
const results = await Promise.all([one.closed, two.closed]);
const joinedResources = scopedResources(1, 0, 0);
check(joinedResources.processWorkers === 0, "result joins all descendant workers");
for (let index = 0; index < results.length; index++) {
	const exit = results[index]!;
	const expected = index === 0 ? "first" : "second";
	check(
		exit.reason === "completed" && exit.code === 0 && exit.hasResult,
		"completed snapshot",
	);
	const result = exit.result as ApplicationResult;
	check(
		result.generation === expected && result.child.generation === expected,
		"same href child domain",
	);
	check(result.child.asset === expected, "shared asset generation");
	check(
		result.main &&
			result.threadId === 0 &&
			result.parentPort === null &&
			result.workerData === undefined,
		"logical main thread",
	);
	check(
		result.count === 1 && result.order.join() === "started,settled",
		"fresh state and ordered TLA",
	);
	check(
		JSON.stringify(result.argv) ===
			JSON.stringify([
				"application-host",
				first.entryPath,
				"argument with spaces",
				"tail",
			]),
		"owned argv and script slot",
	);
	check(result.data.nested.join() === "1,2", "application data snapshot");
	check(
		result.resources.loadedImages === 0 &&
			result.resources.runningApplications === 0 &&
			result.resources.ownedWorkers === 1,
		"application sees only its direct child",
	);
}
const repeated = await launch(a).closed;
check((repeated.result as ApplicationResult).count === 1, "repeated module state fresh");
const evaluationGate = new Int32Array(new SharedArrayBuffer(8));
const evaluating = launch(a, "evaluation-gate", evaluationGate.buffer);
const evaluationOutcome = evaluating.ready.then(
	() => "fulfilled",
	() => "rejected",
);
const readinessOutcome = evaluating.applicationReady.then(
	() => "fulfilled",
	() => "rejected",
);
while (Atomics.load(evaluationGate, 1) === 0)
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 1);
	});
check(scopedResources(1, 1, 0).processWorkers === 1, "pending evaluation owns its root");
const interrupted = await evaluating.terminate();
check(
	interrupted.reason === "terminated" && !interrupted.hasResult,
	"pending evaluation terminates without a result",
);
check(
	(await evaluationOutcome) === "rejected" && (await readinessOutcome) === "rejected",
	"termination rejects both pending readiness promises",
);
check(scopedResources(1, 0, 0).processWorkers === 0, "pending evaluation thread joined");
const absent = await launch(a, "undefined").closed;
check(absent.hasResult && absent.result === undefined, "undefined result presence");
const parked = launch(a, "park");
await parked.ready;
await parked.applicationReady;
check((await parked.terminate()).reason === "terminated", "terminate live app resources");
const rejectedTla = await launch(a, "reject").closed;
check(
	rejectedTla.reason === "error" &&
		(rejectedTla.error as Error).message === "application TLA rejected",
	"TLA rejection",
);
const throwing = await launch(a, "throw-result").closed;
check(
	throwing.reason === "error" && throwing.hasResult && throwing.result === "before throw",
	"error after result",
);
check((await launch(a, "exit").closed).code === 7, "application local process exit");
bridge._releaseApplicationImage(a);
const closedResources = scopedResources(0, 0, 0);
check(
	closedResources.processImageDomains === 2 && closedResources.processWorkerWireBytes > 0,
	"escaped URLs retain domains after image close",
);
const escaped = new Worker((results[0].result as ApplicationResult).url);
await escaped.ready;
check(
	scopedResources(0, 0, 1).processWorkers === 1,
	"escaped worker belongs to receiving isolate",
);
const answer = new Promise<ChildResult>((resolve) => {
	escaped.port.addEventListener(
		"message",
		(event) => resolve((event as MessageEvent<ChildResult>).data),
		{ once: true },
	);
});
escaped.port.postMessage(null);
check((await answer).asset === "first", "escaped URL retains assets");
await escaped.terminate();
check(scopedResources(0, 0, 0).processWorkers === 0, "escaped worker joined");
process.stdout.write("application images PASS\n");
