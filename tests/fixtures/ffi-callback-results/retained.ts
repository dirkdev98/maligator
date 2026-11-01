/* oxlint-disable no-console -- The fixture reports observable registration lifetimes. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/results";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
c.result_retain((index) => {
	collect();
	return index === 0 ? "first" : "second";
});
check(
	c.result_retained_call(0) === "first" && c.result_retained_call(1) === "second",
	"retained callbacks publish independent pointers",
);
collect();
check(
	c.result_retained_matches("first", "second") === 1,
	"native copies survive subsequent calls and GC",
);
c.result_retained_clear();
await c.result_retain_async((index) => {
	collect();
	return index === 0 ? "async-first" : "async-second";
});
check(
	(await c.result_retained_call_async(0)) === "async-first",
	"worker invocation returns retained text",
);
check(
	(await c.result_retained_call_async(1)) === "async-second",
	"worker invocation preserves earlier text",
);
check(
	c.result_retained_matches("async-first", "async-second") === 1,
	"async registration owns all results",
);
await c.result_retained_clear_async();

for (const invoke of [c.result_retained_call, c.result_retained_call_async]) {
	c.result_retain(() => {
		c.result_retained_clear();
		return "too-late";
	});
	let rejected = false;
	try {
		await invoke(0);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, "self-release rejects publication into an ended registration");
}
c.result_retain(() => {
	c.result_retained_clear();
	return null;
});
check(
	c.result_retained_call(0) === null,
	"self-release can return null without publishing storage",
);

await c.result_replace_async((index) => `original-${index}`);
check(
	(await c.result_replaced_call_async(0)) === "original-0",
	"replacement callbacks own result regions",
);
c.result_replace((index) => {
	c.result_replace((next) => `fresh-${next}`);
	return `expired-${index}`;
});
let replacementRejected = false;
try {
	c.result_replaced_call(0);
} catch (error) {
	replacementRejected = error instanceof TypeError;
}
check(replacementRejected, "reentrant replacement ends the previous result region");
check(
	c.result_replaced_call(0) === "fresh-0",
	"failed old publication preserves the new registration",
);
c.result_replace(null);

const source = new ArrayBuffer(3);
new Uint8Array(source).set([5, 0, 7]);
let overflow = false;
await c.result_retain_bytes_async((index) => {
	if (index === 0) return new Uint8Array(source);
	if (overflow) return new Uint8Array(256);
	new Uint8Array(source.transfer()).fill(99);
	collect();
	return new Uint8Array([9]);
});
await c.result_retained_bytes_call_async(0);
await c.result_retained_bytes_call_async(1);
check(
	c.result_retained_bytes_sum(0) === 12 && c.result_retained_bytes_sum(1) === 9,
	"retained byte results survive transfer and mutation",
);
overflow = true;
let countRejected = false;
try {
	await c.result_retained_bytes_call_async(1);
} catch (error) {
	countRejected = error instanceof RangeError;
}
check(
	countRejected && c.result_retained_bytes_sum(0) === 12,
	"conversion failure preserves prior retained results",
);
await c.result_retained_bytes_clear_async();
c.result_retain_bytes(() => {
	c.result_retained_bytes_clear();
	return new Uint8Array([1]);
});
let bytesRejected = false;
try {
	c.result_retained_bytes_call(0);
} catch (error) {
	bytesRejected = error instanceof TypeError;
}
check(bytesRejected, "self-release returns zero pointer and count for bytes");
console.log("retained callback results passed");
