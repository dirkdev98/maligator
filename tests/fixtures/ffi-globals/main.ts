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
	getValues,
	setValues,
	getMatrix,
	setMatrix,
	getPoints,
	setPoints,
	getFixedValues,
	getSignals,
	setSignals,
	getThreads,
	setThreads,
	getLabel,
	setLabel,
	getBytes,
	setBytes,
	getSignedBytes,
	setSignedBytes,
	getVolatileBytes,
	setVolatileBytes,
	getFixedLabel,
	getThreadLabel,
	setThreadLabel,
	setSink,
	globals_sink_text,
	globals_unterminate_label,
	globals_label_byte,
	GLOBALS_TEXT_CAPACITY,
	GLOBALS_BYTE_CAPACITY,
	globals_advance,
	globals_select,
	globals_destroyed,
} from "maligator:ffi/globals";
/* oxlint-disable no-console -- The fixture reports observable C behavior. */
import { createWorkerUrl, Worker } from "maligator:workers";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function rejects(action: () => unknown): boolean {
	try {
		action();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}
for (const unit of ["x", "é", "☃", "😀", "\ud800"]) {
	const width = new TextEncoder().encode(unit).length;
	const text =
		unit.repeat(Math.floor((GLOBALS_TEXT_CAPACITY - 1) / width)) +
		"x".repeat((GLOBALS_TEXT_CAPACITY - 1) % width);
	setLabel(text);
	const expected = new TextDecoder().decode(new TextEncoder().encode(text));
	check(
		getLabel() === expected,
		"global strings check UTF8 capacity and preserve encoding",
	);
}
const previousLabel = getLabel();
for (const text of [
	"x".repeat(GLOBALS_TEXT_CAPACITY),
	"é".repeat(GLOBALS_TEXT_CAPACITY / 2),
	"bad\0text",
])
	check(
		rejects(() => setLabel(text)) && getLabel() === previousLabel,
		"rejected text cannot partially change a global",
	);
setLabel("q");
for (let index = 1; index < GLOBALS_TEXT_CAPACITY; index++)
	check(globals_label_byte(index) === 0, "short text clears the previous array tail");
check(previousLabel.length > getLabel().length, "global text results remain independent");
setLabel("");
check(getLabel() === "", "empty global text is terminated");
globals_unterminate_label();
check(
	rejects(() => getLabel()),
	"global text reads never search beyond the array bound",
);
setLabel("restored");
check(getFixedLabel() === "fixed", "const array aliases can be read as text");
setSink("new");
check(
	globals_sink_text() === "new",
	"setter-only text facts use the same bounded conversion",
);
const originalBytes = getBytes();
check(
	originalBytes instanceof Uint8Array && originalBytes.join(",") === "0,127,128,255",
	"global bytes preserve high bits",
);
const inputBytes = new Uint8Array(GLOBALS_BYTE_CAPACITY).fill(255);
setBytes(new DataView(inputBytes.buffer));
inputBytes.fill(0);
check(
	getBytes().every((byte) => byte === 255) && originalBytes[0] === 0,
	"byte accessors copy both inputs and results",
);
for (const length of [GLOBALS_BYTE_CAPACITY - 1, GLOBALS_BYTE_CAPACITY + 1])
	check(
		rejects(() => setBytes(new Uint8Array(length))) &&
			getBytes().every((byte) => byte === 255),
		"byte writes require an exact capacity without partial changes",
	);
const snapshot = getBytes();
snapshot.fill(7);
check(getBytes()[0] === 255, "mutating a byte snapshot cannot change C storage");
const highBytes = new Uint8Array([255, 128, 0, 127]);
setSignedBytes(highBytes);
setVolatileBytes(highBytes);
check(
	getSignedBytes().join(",") === highBytes.join(",") &&
		getVolatileBytes().join(",") === highBytes.join(","),
	"signed and volatile byte arrays preserve bit patterns",
);
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
const originalValues = getValues();
setValues([21, 22]);
check(originalValues[0] === 1 && getValues()[1] === 22, "array reads copy C storage");
check(getFixedValues()[1] === 12, "const array typedef reads preserve their value");
setSignals([23, 24]);
check(getSignals()[0] === 23, "volatile array access");
setThreads([25, 26]);
check(getThreads()[1] === 26, "thread-local array access");
setPoints([
	{ x: 27, y: 28 },
	{ x: 29, y: 30 },
]);
check(getPoints()[1].y === 30, "record array conversion");
setMatrix([
	[31, 32],
	[33, 34],
]);
check(getMatrix()[1][0] === 33, "multidimensional array conversion");
refused = false;
try {
	setMatrix([
		[40, 41],
		[42, 1.5],
	]);
} catch (error) {
	refused = error instanceof RangeError;
}
check(
	refused && getMatrix()[0][0] === 31,
	"invalid nested input cannot partially write C storage",
);
const nested: [[number, number], [number, number]] = [
	[0, 0],
	[45, 46],
];
Object.defineProperty(nested, "0", {
	get() {
		const row: [number, number] = [0, 0];
		Object.defineProperty(row, "0", {
			get() {
				return getPoint().x + 40;
			},
		});
		Object.defineProperty(row, "1", {
			get() {
				return getPoint().y + 40;
			},
		});
		return row;
	},
});
setMatrix(nested);
check(
	getMatrix()[0][1] === original.y + 40,
	"fresh nested arrays survive allocating element getters",
);
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
setThreadLabel("main");
const worker = new Worker(createWorkerUrl("./worker.ts", import.meta.url));
const result = new Promise<unknown>((resolve) => {
	worker.port.onmessage = (event) => resolve(event.data);
});
worker.port.start();
await worker.ready;
worker.port.postMessage(0);
const reply = (await result) as {
	initial: number;
	updated: number;
	mode: number;
	initialArray: number;
	updatedArray: number;
	initialText: string;
	updatedText: string;
};
check(
	reply.initial === 17 &&
		reply.updated === 33 &&
		reply.mode === 23 &&
		getThread() === 99 &&
		reply.initialArray === 15 &&
		reply.updatedArray === 35 &&
		getThreads()[0] === 25 &&
		reply.initialText === "thread" &&
		reply.updatedText === "child" &&
		getThreadLabel() === "main",
	"accessors observe the calling thread's TLS and shared C objects",
);
await worker.terminate();
console.log("global accessors passed");
