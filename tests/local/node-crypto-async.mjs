// Asynchronous node:crypto acceptance fixture (behind surface.node).
//
// What this pins that the synchronous fixture cannot: the callback is
// unreachable from JavaScript between `argon2(...)` returning and the macrotask
// drain, so it survives only through the module's GC root source; the worker
// reads copied native bytes, so mutating or detaching the inputs mid-derivation
// cannot corrupt a result; the event loop keeps making progress (timers and a
// node:http round trip) while derivations run; and every callback fires exactly
// once, on success and on failure alike.
//
// Prints one line per check and a final "RESULT <passed>/<total>" line.

import { argon2, argon2Sync, randomBytes, randomInt } from "node:crypto";
import * as http from "node:http";

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

// `registered` counts every callback handed to a crypto API, `callbackCount`
// counts deliveries. They must end equal: a dropped callback leaves the total
// short, a double delivery overshoots.
let registered = 0;
let callbackCount = 0;
function counted(fn) {
	registered++;
	return (...args) => {
		callbackCount++;
		fn(...args);
	};
}

const parameters = (overrides = {}) => ({
	message: Buffer.alloc(32, 0x01),
	nonce: Buffer.alloc(16, 0x02),
	secret: Buffer.alloc(8, 0x03),
	associatedData: Buffer.alloc(12, 0x04),
	parallelism: 4,
	tagLength: 32,
	memory: 32,
	passes: 3,
	...overrides,
});

const RFC9106_ID = "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";

let pending = 0;
function begin() {
	pending++;
}
function end() {
	pending--;
	if (pending === 0) report();
}

// --- 1. async equals sync, and the error argument is exactly null ------------
begin();
argon2(
	"argon2id",
	parameters(),
	counted((error, tag) => {
		check("argon2 callback error argument is null", error === null);
		check("argon2 matches the RFC 9106 vector", tag.toString("hex") === RFC9106_ID);
		check(
			"argon2 agrees with argon2Sync",
			tag.toString("hex") === argon2Sync("argon2id", parameters()).toString("hex"),
		);
		check("argon2 resolves with a Buffer", Buffer.isBuffer(tag));
		end();
	}),
);

// --- 2. four concurrent jobs stay independent -------------------------------
// More jobs than the default two workers, so at least two are queued behind a
// running derivation.
const concurrent = [0x11, 0x22, 0x33, 0x44];
const expectedConcurrent = concurrent.map((fill) =>
	argon2Sync("argon2id", parameters({ message: Buffer.alloc(32, fill) })).toString("hex"),
);
const observedConcurrent = new Array(concurrent.length);
for (const [index, fill] of concurrent.entries()) {
	begin();
	argon2(
		"argon2id",
		parameters({ message: Buffer.alloc(32, fill) }),
		counted((error, tag) => {
			observedConcurrent[index] = error === null ? tag.toString("hex") : String(error);
			if (
				observedConcurrent.filter((value) => value !== undefined).length ===
				concurrent.length
			) {
				check(
					"four concurrent derivations return four independent tags",
					observedConcurrent.every((value, i) => value === expectedConcurrent[i]),
				);
				check(
					"concurrent tags are distinct",
					new Set(observedConcurrent).size === concurrent.length,
				);
			}
			end();
		}),
	);
}

// --- 3. the worker reads copies, so mutating the inputs cannot corrupt it ----
const mutable = Buffer.alloc(32, 0x01);
const detachable = new Uint8Array(16).fill(0x02);
begin();
argon2(
	"argon2id",
	parameters({ message: mutable, nonce: detachable }),
	counted((error, tag) => {
		check(
			"mutating an input mid-derivation does not change the tag",
			error === null && tag.toString("hex") === RFC9106_ID,
		);
		end();
	}),
);
mutable.fill(0xff);
detachable.fill(0xff);

// --- 4. a GC between the call and the drain must not collect the callback ----
// The callback and its async context are reachable only from the module's root
// source at this point; the allocation churn below is what makes a collection
// land inside that window under MAL_GC_STRESS.
const gcMarker = { tag: "argon2-gc" };
begin();
argon2(
	"argon2id",
	parameters({ passes: 4 }),
	counted((error, tag) => {
		check(
			"a callback survives a collection before its drain",
			error === null && gcMarker.tag === "argon2-gc" && tag.length === 32,
		);
		end();
	}),
);
let churn = [];
for (let i = 0; i < 20000; i++) churn.push({ index: i, text: "x".repeat(8) });
churn = null;

// --- 5. failures deliver an Error through the callback, exactly once ---------
// The host resource policy turns a pathological request into a JavaScript error
// instead of a process abort; Node is SIGKILLed for the same input, so this can
// never be a differential case. A refusal that happens before the job is queued
// is thrown synchronously, and then the callback must never fire; a refusal
// discovered on the worker arrives through the callback. Both are acceptable;
// what must not happen is a silent success, a crash, or a double delivery.
for (const [label, overrides] of [
	["memory", { memory: 4294967295 }],
	["tagLength", { tagLength: 4294967295 }],
]) {
	// Exactly one of the two outcomes must happen, and the global
	// registered/callbackCount equality below proves it happened exactly once.
	let outcomes = 0;
	begin();
	try {
		argon2(
			"argon2id",
			parameters(overrides),
			counted((error) => {
				outcomes++;
				check(
					"an over-policy " + label + " reaches the callback as an Error",
					error instanceof Error && outcomes === 1,
				);
				end();
			}),
		);
	} catch (error) {
		outcomes++;
		registered--;
		check(
			"an over-policy " + label + " is refused as an Error",
			error instanceof Error && outcomes === 1,
		);
		end();
	}
}

// --- 6. randomBytes / randomInt callback forms -------------------------------
begin();
randomBytes(
	18,
	counted((error, buffer) => {
		check("randomBytes callback error argument is null", error === null);
		check(
			"randomBytes callback yields the requested length",
			Buffer.isBuffer(buffer) && buffer.length === 18,
		);
		end();
	}),
);
begin();
randomInt(
	0,
	100,
	counted((error, value) => {
		// Node really does pass `undefined` here and `null` to randomBytes.
		check("randomInt callback error argument is undefined", error === undefined);
		check(
			"randomInt callback yields an in-range integer",
			Number.isInteger(value) && value >= 0 && value < 100,
		);
		end();
	}),
);
begin();
randomInt(
	7,
	counted((error, value) => {
		check(
			"randomInt callback form defaults min to 0",
			error === undefined && value >= 0 && value < 7,
		);
		end();
	}),
);

// --- 7. the loop keeps making progress while derivations run ----------------
let ticks = 0;
const interval = setInterval(() => {
	ticks++;
	if (ticks >= 3) clearInterval(interval);
}, 1);

begin();
const server = http.createServer((request, response) => {
	response.end("pong");
});
server.listen(0, () => {
	const port = server.address().port;
	// A long derivation runs concurrently with this request; if the derivation
	// blocked the reactor thread the response would never arrive.
	begin();
	argon2(
		"argon2id",
		parameters({ memory: 4096, passes: 6 }),
		counted((error, tag) => {
			check(
				"a long derivation completes alongside live I/O",
				error === null && tag.length === 32,
			);
			end();
		}),
	);
	const request = http.request({ port, path: "/", method: "GET" }, (response) => {
		const chunks = [];
		response.on("data", (chunk) => chunks.push(chunk));
		response.on("end", () => {
			check(
				"an HTTP round trip completes during a derivation",
				Buffer.concat(chunks).toString("utf8") === "pong",
			);
			server.close();
			end();
		});
	});
	request.end();
});

function report() {
	check("the event loop kept ticking during the derivations", ticks >= 2);
	check(
		"every callback fired exactly once",
		callbackCount === registered && registered > 0,
	);
	let passed = 0;
	for (const [name, ok] of results) {
		if (ok) {
			passed++;
		} else {
			console.log("FAIL: " + name);
		}
	}
	console.log("RESULT " + passed + "/" + results.length);
}
