// Transient `crypto.argon2` start failures (behind surface.node).
//
// A call that has already accepted a callback must report a transient host
// condition through that callback, exactly once, rather than throwing out of a
// call the caller has no reason to wrap in a try/catch. Two conditions produce
// one: no worker available, and a full queue. Argument and policy errors are
// the opposite contract and stay synchronous — those are pinned by
// node-crypto-async.mjs.
//
// Requires the one-worker, one-slot, deliberately-slow pool that
// runtime/crypto_start_failure_test_main.c stands up; the default pool reaches
// neither condition. Prints one line per check and a final "RESULT p/t" line.

import { argon2 } from "node:crypto";

const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

const parameters = {
	message: Buffer.alloc(32, 0x01),
	nonce: Buffer.alloc(16, 0x02),
	parallelism: 1,
	tagLength: 32,
	memory: 8,
	passes: 1,
};

// The driver armed exactly one empty pool start, so this call cannot reach a
// worker. It must still return normally.
let firstThrew = null;
let firstCalls = 0;
try {
	argon2("argon2id", parameters, (error, tag) => {
		firstCalls++;
		check(
			"a worker-unavailable start reaches the callback as an Error",
			error instanceof Error && tag === undefined,
		);
		check("its message names the transient condition", String(error?.message).length > 0);
		saturate();
	});
} catch (error) {
	firstThrew = error;
	report();
}
check("a worker-unavailable start does not throw synchronously", firstThrew === null);

// The pool is retryable after that failed start, so this burst brings it up for
// real: one job runs, one queues, and the rest find the single slot taken. The
// worker holds its derivation long enough that a synchronous burst cannot drain
// through it.
const BURST = 16;
let delivered = 0;
let saturated = 0;
let derived = 0;
let burstThrew = 0;

function saturate() {
	for (let index = 0; index < BURST; index++) {
		try {
			argon2("argon2id", parameters, (error, tag) => {
				delivered++;
				if (error instanceof Error) {
					saturated++;
				} else if (error === null && tag?.length === 32) {
					derived++;
				}
				if (delivered === BURST) finish();
			});
		} catch {
			burstThrew++;
		}
	}
	if (burstThrew === BURST) finish();
}

function finish() {
	check("no call in the burst threw synchronously", burstThrew === 0);
	check("every callback in the burst fired exactly once", delivered === BURST);
	// The first call always finds the slot free, so at least one job derives and
	// the rest meet a queue that its 250ms derivation is holding full.
	check("the failed start left the pool able to derive again", derived >= 1);
	check("a full queue reaches the callback as an Error", saturated >= 10);
	check("the first call's callback fired exactly once", firstCalls === 1);
	report();
}

function report() {
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
