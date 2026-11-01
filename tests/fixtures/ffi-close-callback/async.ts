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
const retry = c.CloseState();
const retained = new ArrayBuffer(8);
retry.bytes = retained;
let schedulingRejected = false;
try {
	await c.close_now_async(retry, () => {
		throw new Error("rejected close entered C");
	});
} catch (error) {
	schedulingRejected = error instanceof Error && error.message.includes("scheduled");
} finally {
	c.close_unblock();
}
check(
	schedulingRejected && c.close_read(retry) === 0,
	"admission restores handle ownership",
);
retry.bytes = null;
check(retained.transfer().byteLength === 8, "admission restores managed field access");
await Promise.all(blockers);
await c.close_now_async(retry, () => {});
console.log("async close callbacks passed");
