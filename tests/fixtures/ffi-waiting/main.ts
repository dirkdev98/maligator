/* oxlint-disable no-console -- The fixture reports observable C results. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	waiting_set_integer,
	waiting_set_record,
	waiting_set_void,
	waiting_set_keyed,
	waiting_clear,
	waiting_call_integer,
	waiting_call_keyed,
	waiting_start,
	waiting_join_async,
	waiting_cancel,
	waiting_canceled,
} from "maligator:ffi/waiting";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
const values: Array<number> = [];
waiting_set_integer((value) => {
	if (value === 1000) return waiting_call_integer(7);
	values.push(value);
	return value * 3;
});
check(waiting_call_integer(1000) === 21, "same-thread callbacks can nest");
waiting_start(12, 2, 0);
check(
	(await waiting_join_async()) === 3996,
	"simultaneous producers receive scalar results",
);
check(values.length === 25, "every queued callback runs once");
waiting_set_integer((value) => {
	waiting_cancel();
	return value + 1;
});
waiting_start(1, 1, 0);
check(
	(await waiting_join_async()) === 0 && waiting_canceled() === 1,
	"native cancellation retires the waiting frame",
);
waiting_set_record((value) => ({
	get x() {
		collect();
		return value;
	},
	get y() {
		collect();
		return value + 1;
	},
}));
waiting_start(4, 1, 1);
check((await waiting_join_async()) === 16, "record results survive getter GC");
const notifications: Array<number> = [];
waiting_set_void((value) => {
	notifications.push(value);
});
waiting_start(2, 1, 3);
check(
	(await waiting_join_async()) === 0 && notifications.join(",") === "0,1",
	"void callbacks complete before C continues",
);
waiting_set_integer((value) => {
	waiting_clear();
	return value + 5;
});
waiting_start(1, 1, 0);
check(
	(await waiting_join_async()) === 5,
	"release inside a callback preserves its result",
);
waiting_set_keyed((value) => value + 2);
check(waiting_call_keyed(8) === 10, "keyed callback runs on the VM thread");
waiting_start(3, 2, 2);
check((await waiting_join_async()) === 318, "keyed foreign calls receive their results");
waiting_set_keyed((value) => {
	waiting_set_keyed(null);
	return value + 9;
});
waiting_start(1, 1, 2);
check(
	(await waiting_join_async()) === 9,
	"replacement inside a callback preserves its result",
);
console.log("waiting callbacks passed");
