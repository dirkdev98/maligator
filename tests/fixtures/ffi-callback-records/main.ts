/* oxlint-disable no-console -- The fixture reports one-shot and record callbacks. */
import {
	pending_requests,
	process_events,
	request_device,
	request_threaded,
	request_value,
	visit_values,
} from "maligator:ffi/requests";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

const calls: Array<string> = [];
// A helper keeps TypeScript from narrowing a length that C callbacks change.
const callCount = (): number => calls.length;
check(
	request_device((status, message) => calls.push(`device ${status} ${message}`)) === 0,
	"the record carries the callback and its fixed mode",
);
check(
	calls.length === 0 && pending_requests() === 1,
	"the callback runs after the call returns",
);
process_events();
check(calls.join() === "device 0 ready", "the deferred callback ran once");
process_events();
check(callCount() === 1, "no second call");

request_value(41, (value) => calls.push(`value ${value}`));
process_events();
check(calls.at(-1) === "value 41", "a one-shot callback parameter");

request_value(1, () => {
	throw new Error("one-shot failure");
});
let caught: unknown;
try {
	process_events();
} catch (error) {
	caught = error;
}
check(
	caught instanceof Error && caught.message === "one-shot failure",
	"its exception reaches the call that ran it",
);
check(pending_requests() === 0, "a failed one-shot callback is still consumed");

check(visit_values(4, (value) => value * 2) === 12, "a call-scoped record callback");

const threaded = await new Promise<number>((resolve) => {
	check(request_threaded(7, resolve) === 0, "the thread started");
});
check(threaded === 7, "a queued one-shot callback from another thread");

console.log("callback records passed");
