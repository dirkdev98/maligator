/* oxlint-disable no-console -- The fixture reports observable native behavior. */
import * as c from "maligator:ffi/worker";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

function refusesAlias(resource: c.WorkerResource): void {
	let refused = false;
	try {
		c.worker_alias(resource);
	} catch (error) {
		refused = error instanceof TypeError;
	}
	check(refused, "an unsettled close blocks aliases of its family");
}

const survivor = c.worker_open(41)!;
const first = c.worker_open(43)!;
const second = c.worker_open(47)!;
const unrelated = c.worker_reused_open(53)!;
check(c.worker_alias(survivor) === survivor, "settled aliases preserve identity");
c.worker_hold();
const firstClose = c.worker_close_async(first);
const secondClose = c.worker_close_async(second);
try {
	refusesAlias(survivor);
	check(c.worker_reused_alias() === unrelated, "other families still return aliases");
} finally {
	c.worker_unblock_later();
}
check((await firstClose) === 7 && (await secondClose) === 7, "both closes settle");
check(
	c.worker_alias(survivor) === survivor,
	"settling every close permits aliases again",
);
const retry = c.worker_retry_open(1)!;
check(!(await c.worker_retry_close_async(retry)), "a failed close preserves its handle");
const nextRetry = c.worker_retry_open(0)!;
check(c.worker_retry_close(nextRetry), "a failed close releases its result guard");
check(await c.worker_retry_close_async(retry), "a retried close releases its handle");
c.worker_close(survivor);
c.worker_reused_close(unrelated);
check(c.worker_live() === 0, "all resources release once");
console.log("worker result guards passed");
