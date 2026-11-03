/* oxlint-disable no-console -- The fixture reports observable global lifetime behavior. */
import {
	getRetainedTitle,
	setRetainedTitle,
	getRetainedBytes,
	setRetainedBytes,
	getRetainedCount,
	getRetainedVoid,
	setRetainedVoid,
	globals_retained_negative_count,
	globals_retained_advance,
	globals_retained_corrupt_count,
	globals_retained_corrupt_title,
	globals_retained_corrupt_pointer,
	globals_retained_restore,
	globals_retained_nonnull,
} from "maligator:ffi/globals";
import { createWorkerUrl, Worker } from "maligator:workers";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function rejects(run: () => unknown, kind: typeof TypeError | typeof RangeError): void {
	let caught = false;
	try {
		run();
	} catch (error) {
		caught = error instanceof kind;
	}
	check(caught, `expected ${kind.name}`);
}
check(
	getRetainedTitle() === "initial" && getRetainedBytes()?.join() === "1,2,3",
	"initial C storage stays library-owned",
);
setRetainedVoid(new Uint8Array([12, 13]));
check(
	getRetainedVoid()?.join() === "12,13",
	"void pointers copy byte storage with a signed count",
);
globals_retained_negative_count();
rejects(getRetainedVoid, RangeError);
setRetainedVoid(null);
check(getRetainedVoid() === null, "clearing repairs a negative native count");
setRetainedTitle("hello 🌱");
const source = new Uint8Array([4, 5, 6]);
setRetainedBytes(source);
source[0] = 99;
source.buffer.transfer();
check(
	getRetainedTitle() === "hello 🌱" &&
		getRetainedBytes()?.join() === "4,5,6" &&
		getRetainedCount() === 3,
	"globals hold independent native copies",
);
const snapshot = getRetainedBytes()!;
snapshot[0] = 88;
check(getRetainedBytes()?.[0] === 4, "getters return independent snapshots");
rejects(() => setRetainedTitle("bad\0text"), TypeError);
rejects(() => setRetainedBytes(new Uint8Array(256)), RangeError);
rejects(() => setRetainedBytes(source), TypeError);
rejects(() => setRetainedBytes(7 as never), TypeError);
check(
	getRetainedTitle() === "hello 🌱" && getRetainedBytes()?.join() === "4,5,6",
	"conversion failures preserve pointer and count",
);
globals_retained_advance();
check(
	getRetainedTitle() === "ello 🌱" && getRetainedBytes()?.join() === "5,6",
	"C may advance a retained pointer within its allocation",
);
globals_retained_corrupt_count();
rejects(getRetainedBytes, RangeError);
globals_retained_restore();
globals_retained_corrupt_pointer();
rejects(getRetainedBytes, RangeError);
globals_retained_restore();
globals_retained_corrupt_title();
rejects(getRetainedTitle, RangeError);
globals_retained_restore();
setRetainedTitle("");
setRetainedBytes(new Uint8Array(0));
check(
	getRetainedTitle() === "" &&
		getRetainedBytes()?.length === 0 &&
		globals_retained_nonnull() === 1,
	"empty values retain nonnull native storage",
);
setRetainedTitle(null);
setRetainedBytes(null);
check(
	getRetainedTitle() === null &&
		getRetainedBytes() === null &&
		getRetainedCount() === 0 &&
		globals_retained_nonnull() === 0,
	"clearing releases owned storage and resets the count",
);
for (let round = 0; round < 2; round++) {
	const worker = new Worker(createWorkerUrl("./retained-worker.ts", import.meta.url));
	const reply = new Promise<unknown>((resolve) => {
		worker.port.onmessage = (event) => resolve(event.data);
	});
	worker.port.start();
	await worker.ready;
	worker.port.postMessage(0);
	await reply;
	await worker.terminate();
	check(
		getRetainedTitle() === "worker 🚀" && getRetainedBytes()?.join() === "7,8,9",
		"native copies survive the assigning worker's teardown",
	);
}
setRetainedTitle("é".repeat(17));
setRetainedBytes(new Uint8Array(17).fill(17));
const racers = [17, 37].map((size) => {
	const worker = new Worker(
		createWorkerUrl("./retained-race-worker.ts", import.meta.url),
	);
	const done = new Promise<unknown>((resolve) => {
		worker.port.onmessage = (event) => resolve(event.data);
	});
	worker.port.start();
	return { worker, done, size };
});
await Promise.all(racers.map(({ worker }) => worker.ready));
for (const { worker, size } of racers) worker.port.postMessage(size);
for (let sample = 0; sample < 250; sample++) {
	const bytes = getRetainedBytes();
	check(
		bytes !== null &&
			(bytes.length === 17 || bytes.length === 37) &&
			bytes.every((byte) => byte === bytes.length),
		"concurrent byte readers see complete native copies",
	);
	const text = getRetainedTitle();
	check(
		text === "é".repeat(17) || text === "é".repeat(37),
		"concurrent text readers see complete native copies",
	);
	const count = getRetainedCount();
	check(
		count === 17 || count === 37,
		"count getters synchronize with native replacements",
	);
}
await Promise.all(racers.map(({ done }) => done));
await Promise.all(racers.map(({ worker }) => worker.terminate()));
setRetainedTitle("parent");
setRetainedBytes(new Uint8Array([10, 11]));
check(
	getRetainedTitle() === "parent" && getRetainedBytes()?.join() === "10,11",
	"another VM can replace retained native storage",
);
setRetainedTitle(null);
setRetainedBytes(null);
console.log("retained globals passed");
