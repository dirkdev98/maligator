import {
	getMode,
	setMode,
	getLimit,
	getAliasedLimit,
	getFixedPoint,
	getSignal,
	setSignal,
	getSerial,
	setSerial,
	getRatio,
	setRatio,
	getThread,
	setThread,
	getPoint,
	setPoint,
	getTitle,
	getContext,
	getTransform,
	globals_advance,
	globals_select,
	globals_destroyed,
} from "maligator:ffi/globals";
/* oxlint-disable no-console -- The fixture reports observable C behavior. */
import { createWorkerUrl, Worker } from "maligator:workers";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
check(getMode() === 3 && getLimit() === 42, "read current scalar and const globals");
check(
	getAliasedLimit() === 37 && getFixedPoint().y === 6,
	"read const aliases and records",
);
setSignal(5);
check(getSignal() === 5, "access volatile C storage");
setMode(7);
globals_advance();
check(getMode() === 8, "ordinary C calls observe setter state");
let refused = false;
try {
	setMode(1.5);
} catch (error) {
	refused = error instanceof RangeError;
}
check(refused && getMode() === 8, "invalid conversion cannot change a global");
setSerial(18446744073709551615n);
check(getSerial() === 18446744073709551615n, "exact unsigned global value");
setRatio(-0);
check(Object.is(getRatio(), -0), "global floating value preserves negative zero");
setRatio(NaN);
check(Number.isNaN(getRatio()), "global floating value preserves NaN");
const original = getPoint();
setPoint({
	get x() {
		globals_advance();
		return 11;
	},
	y: 13,
});
check(
	getPoint().x === 11 && getPoint().y === 13 && original.x === 2,
	"record setter stages getters before assigning C storage",
);
refused = false;
try {
	setPoint({
		x: 20,
		get y(): number {
			throw new Error("point getter");
		},
	});
} catch (error) {
	refused = error instanceof Error && error.message === "point getter";
}
check(
	refused && getPoint().x === 11 && getPoint().y === 13,
	"throwing record conversion cannot partially write a global",
);
const title = getTitle();
const transform = getTransform();
check(
	title === "north" && transform !== null && transform(4) === 5,
	"read pointer globals",
);
globals_select(1);
const nextTransform = getTransform();
check(
	title === "north" && getTitle() === "south",
	"global text reads are independent copies",
);
check(
	transform !== null &&
		transform(4) === 5 &&
		nextTransform !== null &&
		nextTransform(4) === 12,
	"function-pointer global getters capture each current target",
);
const context = getContext();
check(context !== null, "borrow global context");
context[Symbol.dispose]();
check(
	globals_destroyed() === 0,
	"closing a borrowed global handle preserves C ownership",
);
setMode(23);
setThread(99);
const worker = new Worker(createWorkerUrl("./worker.ts", import.meta.url));
const result = new Promise<unknown>((resolve) => {
	worker.port.onmessage = (event) => resolve(event.data);
});
worker.port.start();
await worker.ready;
worker.port.postMessage(0);
const reply = (await result) as { initial: number; updated: number; mode: number };
check(
	reply.initial === 17 && reply.updated === 33 && reply.mode === 23 && getThread() === 99,
	"accessors observe the calling thread's TLS and shared C objects",
);
await worker.terminate();
console.log("global accessors passed");
