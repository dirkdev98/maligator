/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/worker";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function refuses(action: () => void): void {
	let refused = false;
	try {
		action();
	} catch (error) {
		refused = error instanceof TypeError;
	}
	check(refused, "a closing handle rejects other operations");
}

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;
const retry = c.worker_retry_open(1)!;
check((await c.worker_retry_close_async(retry)) === false, "C failure preserves status");
check(c.worker_retry_left(retry) === 0, "failed cleanup preserves the handle");
check(await c.worker_retry_close_async(retry), "conditional cleanup retries");
refuses(() => c.worker_retry_left(retry));
retry[Symbol.dispose]();

const resource = c.worker_open(13)!;
let queuedCalls = 0;
c.worker_watch(resource, (value) => {
	check(value === 13, "worker callback copies its argument");
	queuedCalls++;
});
c.worker_hold();
const result = c.worker_close_async(resource);
try {
	refuses(() => c.worker_value(resource));
	refuses(() => resource[Symbol.dispose]());
	await c.worker_close_async(resource).then(
		() => {
			throw new Error("overlapping cleanup succeeded");
		},
		(error: unknown) => check(error instanceof TypeError, "overlapping cleanup rejects"),
	);
	refuses(() => c.worker_value(resource));
	collectGarbage();
} finally {
	c.worker_unblock_later();
}
check((await result) === 7, "unconditional cleanup keeps its result");
check(queuedCalls === 1, "queued callbacks retire with worker destruction");
refuses(() => c.worker_value(resource));
resource[Symbol.dispose]();

let pending: Promise<number> | undefined;
c.worker_hold();
try {
	await new Promise<void>((resolve) => {
		setTimeout(() => {
			const dropped = c.worker_open(17)!;
			c.worker_watch_direct(dropped, () => {
				throw new Error("release-only callback ran");
			});
			pending = c.worker_close_async(dropped);
			resolve();
		}, 0);
	});
	collectGarbage();
} finally {
	c.worker_unblock_later();
}
check((await pending) === 7, "worker cleanup retains a dropped handle");

const old = c.worker_reused_open(23)!;
c.worker_reused_listen(old, () => {
	throw new Error("an old registration survived address reuse");
});
c.worker_hold();
const closing = c.worker_reused_close_async(old);
let fresh: c.ReusedResource;
let calls = 0;
try {
	c.worker_wait_started();
	refuses(() => {
		c.worker_reused_alias();
	});
	fresh = c.worker_reused_open(29)!;
	check(fresh !== old, "fresh resources at reused addresses have distinct identity");
	c.worker_reused_listen(fresh, (alias) => {
		check(alias === fresh, "new callbacks preserve the new lifetime identity");
		calls++;
	});
} finally {
	c.worker_unblock_later();
}
await closing;
refuses(() => c.worker_reused_value(old));
check(c.worker_reused_value(fresh) === 29, "old completion preserves a new resource");
c.worker_reused_emit(fresh);
check(calls === 1, "old completion preserves new keyed callbacks");
c.worker_reused_close(fresh);
check(c.worker_live() === 0, "every resource releases once");
console.log("worker destruction passed");
