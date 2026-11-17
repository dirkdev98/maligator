/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/close";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function refuses(action: () => void): void {
	let rejected = false;
	try {
		action();
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, "closing handles reject access");
}
function nextTurn(): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

const immediate = c.CloseState();
let immediateDone = false;
await c.close_now_async(immediate, (handle) => {
	check(handle === immediate, "worker completion preserves canonical identity");
	refuses(() => c.close_read(handle));
	immediateDone = true;
});
await nextTurn();
check(immediateDone, "an immediate worker completion runs");

const deferred = c.CloseState();
const backing = new ArrayBuffer(24);
deferred.bytes = new Uint8Array(backing, 3, 11);
let deferredDone = false;
await c.close_later_async(deferred, (handle) => {
	check(handle === deferred, "deferred completion preserves identity");
	deferredDone = true;
});
refuses(() => c.close_read(deferred));
refuses(() => backing.transfer());
collect();
c.close_flush();
check(deferredDone, "completion stays retained after registration settles");
check(backing.transfer().byteLength === 24, "completion retires managed pins");

let status = 0;
await c.close_data_async(c.CloseState(), (value) => {
	status = value;
});
await nextTurn();
check(status === 17, "user data routes a worker completion");

const invalid = c.CloseState();
let invalidRejected = false;
try {
	await c.close_now_async(invalid, null as never);
} catch (error) {
	invalidRejected = error instanceof TypeError;
}
check(
	invalidRejected && c.close_read(invalid) === 0,
	"preparation leaves the handle open",
);
invalid[Symbol.dispose]();

let loanResult: Promise<boolean> | undefined;
c.close_lend((handle) => {
	check(handle !== null, "C lends a handle");
	loanResult = c
		.close_now_async(handle, () => {})
		.then(
			() => false,
			(error: unknown) => error instanceof TypeError,
		);
});
check(
	loanResult !== undefined && (await loanResult),
	"async close rejects a callback loan",
);

let listenerCalls = 0;
let mixedDone = false;
async function closeMixed(): Promise<WeakRef<(value: c.CloseBase | null) => void>> {
	const listener = (_value: c.CloseBase | null) => {
		listenerCalls++;
	};
	const weak = new WeakRef(listener);
	await c.close_and_listen_async(
		c.close_reused_open()!,
		() => {
			mixedDone = true;
		},
		listener,
	);
	return weak;
}
const weak = await closeMixed();
await nextTurn();
collect();
check(listenerCalls === 1 && mixedDone, "replacement commits before completion");
check(weak.deref() === undefined, "completion retires its newly installed listener");

const blockers = Array.from({ length: 128 }, () => c.close_block_async().catch(() => {}));
c.close_wait_blocked();
function attemptClose() {
	const handle = c.CloseState();
	const retained = new ArrayBuffer(8);
	handle.bytes = retained;
	const state = {
		handle,
		retained,
		callbackCalls: 0,
		rejected: false,
		reason: undefined as unknown,
	};
	const pending = c
		.close_now_async(handle, () => {
			state.callbackCalls++;
		})
		.catch((reason: unknown) => {
			state.rejected = true;
			state.reason = reason;
		});
	return { state, pending };
}
const attempts: Array<ReturnType<typeof attemptClose>> = [];
// A late worker start frees queue capacity, so some closes can be admitted.
// Release the gate before awaiting either outcome, including rejected closes.
try {
	for (let index = 0; index < blockers.length; index++) {
		const attempt = attemptClose();
		attempts.push(attempt);
		await Promise.resolve();
		if (attempt.state.rejected) break;
	}
} finally {
	c.close_unblock();
}
await Promise.all([...blockers, ...attempts.map((attempt) => attempt.pending)]);
await nextTurn();
const rejected = attempts.filter((attempt) => attempt.state.rejected);
check(rejected.length > 0, "saturation rejects close admission");
for (const { state } of attempts) {
	if (!state.rejected) {
		check(state.callbackCalls === 1, "admitted closes complete once");
		refuses(() => c.close_read(state.handle));
		continue;
	}
	check(
		state.reason instanceof Error && state.reason.message.includes("scheduled"),
		"saturated closes reject scheduling",
	);
	check(
		state.callbackCalls === 0 && c.close_read(state.handle) === 0,
		"admission restores ownership without entering C",
	);
	state.handle.bytes = null;
	check(
		state.retained.transfer().byteLength === 8,
		"admission restores managed field access",
	);
}
let retried = false;
await c.close_now_async(rejected[0]!.state.handle, () => {
	retried = true;
});
await nextTurn();
check(retried, "a rejected close can be retried");
console.log("async close callbacks passed");
