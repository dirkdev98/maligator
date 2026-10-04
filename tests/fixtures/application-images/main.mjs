import { readFileSync, unlinkSync } from "node:fs";
import process from "node:process";
import { ready } from "maligator:application";
import { Worker } from "maligator:workers";
function check(value, message) {
	if (!value) throw new Error(message);
}
check(ready() === false, "standalone readiness returns false");
const descriptors = process.argv
	.slice(2)
	.map((filename) => JSON.parse(readFileSync(filename, "utf8")));
const [first, second, unresolvedDescriptor] = descriptors;
function rejected(callback, message) {
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
		mal._loadApplicationImage({
			...first,
			engine: { ...first.engine, primordials: "mutable" },
		}),
	"policy rejected",
);
rejected(
	() => mal._loadApplicationImage({ ...first, engine: { ...first.engine, intl: true } }),
	"capability rejected",
);
rejected(
	() =>
		mal._loadApplicationImage({
			...first,
			wires: [{ path: first.wires[0].path, sha256: "0".repeat(64) }],
		}),
	"digest rejected",
);
rejected(
	() =>
		mal._loadApplicationImage({
			...first,
			wires: [{ path: "/missing-image.malw", sha256: first.wires[0].sha256 }],
		}),
	"missing artifact rejected",
);
rejected(() => mal._launchApplicationImage({}, { argv: [] }), "opaque handle identity");
function load(descriptor) {
	return mal._loadApplicationImage(descriptor);
}
function launch(handle, mode = "normal", gate = new SharedArrayBuffer(4)) {
	if (mode !== "gated") Atomics.store(new Int32Array(gate), 0, 1);
	return mal._launchApplicationImage(handle, {
		argv: ["application-host", first.entryPath, "argument with spaces", "tail"],
		data: { mode, nested: [1, 2], gate },
		exitOnResult: true,
	});
}
const unresolvedHandle = load(unresolvedDescriptor);
const unresolvedExit = await launch(unresolvedHandle, "unresolved").closed;
check(
	unresolvedExit.reason === "error" &&
		unresolvedExit.error.message.includes("unresolved top-level await"),
	"unresolved TLA failure",
);
mal._releaseApplicationImage(unresolvedHandle);
const a = load(first);
const b = load(second);
for (const descriptor of [first, second]) {
	for (const entry of JSON.parse(readFileSync(descriptor.workerManifestPath, "utf8"))
		.entries)
		unlinkSync(entry.wirePath);
	unlinkSync(
		descriptor.assetManifestPath.replace("assets-", "asset-").replace(".mala", ".txt"),
	);
}
for (const descriptor of descriptors)
	for (const wire of descriptor.wires) unlinkSync(wire.path);
const startupGate = new SharedArrayBuffer(4);
const one = launch(a, "gated", startupGate);
const two = launch(b);
mal._releaseApplicationImage(b);
mal._releaseApplicationImage(b);
rejected(() => launch(b), "closed handle rejected");
await one.ready;
let signaled = false;
one.applicationReady.then(() => {
	signaled = true;
});
await Promise.resolve();
await Promise.resolve();
check(!signaled, "evaluation precedes gated application readiness");
Atomics.store(new Int32Array(startupGate), 0, 1);
await one.applicationReady;
check(signaled, "application readiness observed");
const results = await Promise.all([one.closed, two.closed]);
for (let index = 0; index < results.length; index++) {
	const exit = results[index];
	const expected = index === 0 ? "first" : "second";
	check(
		exit.reason === "completed" && exit.code === 0 && exit.hasResult,
		"completed snapshot",
	);
	const result = exit.result;
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
}
const repeated = await launch(a).closed;
check(repeated.result.count === 1, "repeated module state fresh");
const absent = await launch(a, "undefined").closed;
check(absent.hasResult && absent.result === undefined, "undefined result presence");
const parked = launch(a, "park");
await parked.ready;
await parked.applicationReady;
check((await parked.terminate()).reason === "terminated", "terminate live app resources");
const rejectedTla = await launch(a, "reject").closed;
check(
	rejectedTla.reason === "error" &&
		rejectedTla.error.message === "application TLA rejected",
	"TLA rejection",
);
const throwing = await launch(a, "throw-result").closed;
check(
	throwing.reason === "error" && throwing.hasResult && throwing.result === "before throw",
	"error after result",
);
check((await launch(a, "exit").closed).code === 7, "application local process exit");
mal._releaseApplicationImage(a);
const escaped = new Worker(results[0].result.url);
await escaped.ready;
const answer = new Promise((resolve) =>
	escaped.port.addEventListener("message", (event) => resolve(event.data), {
		once: true,
	}),
);
escaped.port.postMessage(null);
check((await answer).asset === "first", "escaped URL retains assets");
await escaped.terminate();
console.log("application images PASS");
