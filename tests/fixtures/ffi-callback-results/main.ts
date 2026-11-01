/* oxlint-disable no-console -- The fixture reports observable native pointer lifetimes. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import * as c from "maligator:ffi/results";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
check(
	c.result_scalar(() => 17) === 17,
	"scalar callback results keep their ordinary conversion",
);
const long = "é".repeat(300);
check(
	c.result_text((index) => {
		collect();
		return index === 0 ? "first" : long;
	}) === "first",
	"C retains every string and returns an alias through output conversion",
);
check(
	(await c.result_text_async((index) => {
		collect();
		return index === 0 ? long : "second";
	})) === long,
	"worker results retain heap encodings through completion conversion",
);
check(c.result_text(() => null) === null, "nullable pointer results preserve null");
let nested = 0;
check(
	c.result_scoped((index) => {
		if (index === 1) {
			check(
				c.result_scoped((inner) => `inner-${inner}`) === "inner-0",
				"nested calls have independent regions",
			);
			nested++;
		}
		collect();
		return `outer-${index}`;
	}) === "outer-0" && nested === 1,
	"a nested call preserves earlier outer results",
);
check(
	(await c.result_scoped_async((index) => `worker-${index}`)) === "worker-0",
	"no-data worker callbacks keep result regions",
);
for (const invoke of [c.result_counted, c.result_counted_async]) {
	check(
		(await invoke((index) => {
			collect();
			return index === 0 ? "a\0é🙂" : long;
		})) === "a\0é🙂",
		"callback byte counts preserve unterminated text and NULs",
	);
	check(
		(await invoke((index) => (index === 0 ? "" : "second"))) === "",
		"nonnull empty callback text stays empty",
	);
	const failure = new Error("counted pointer callback failed");
	let same = false;
	try {
		await invoke((index) => {
			if (index === 1) throw failure;
			return "prior";
		});
	} catch (error) {
		same = error === failure;
	}
	check(same, "counted callback failures return a null pointer and zero native count");
}
for (const invoke of [c.result_bytes, c.result_bytes_async]) {
	for (const empty of [new ArrayBuffer(0), new Uint8Array(new ArrayBuffer(8), 3, 0)]) {
		const copied = await invoke((index) => (index === 0 ? empty : new Uint8Array([1])));
		check(
			copied !== null && copied.byteLength === 0,
			"empty native byte results have a nonnull pointer",
		);
	}
	check(
		(await invoke(() => null)) === null,
		"nullable byte results distinguish null from empty",
	);
	const source = new ArrayBuffer(4, { maxByteLength: 16 });
	new Uint8Array(source).set([3, 5, 7, 9]);
	const result = await invoke((index) => {
		if (index === 0) return new Uint8Array(source, 1, 2);
		const transferred = source.transfer();
		new Uint8Array(transferred).fill(99);
		collect();
		return new Uint8Array([11]);
	});
	check(
		result?.join(",") === "5,7",
		"native byte copies survive source transfer and mutation",
	);
	let rejected = false;
	try {
		await invoke(() => new Uint8Array(256));
	} catch (error) {
		rejected = error instanceof RangeError;
	}
	check(rejected, "callback byte lengths must fit their C output count");
}
check(
	(await c.result_parallel_async((index) => {
		collect();
		return index === 0 ? "parallel-first" : long;
	})) === "parallel-first",
	"concurrent library threads preserve every callback result",
);
const failure = new Error("pointer callback failed");
for (const invoke of [c.result_text, c.result_text_async]) {
	let same = false;
	try {
		await invoke((index) => {
			if (index === 1) throw failure;
			return "kept";
		});
	} catch (error) {
		same = error === failure;
	}
	check(same, "callback exceptions preserve prior native results until C returns");
}
let requiredRejected = false;
try {
	c.result_required(() => null as never);
} catch (error) {
	requiredRejected = error instanceof TypeError;
}
check(requiredRejected, "nonnull result facts reject null");
let nulRejected = false;
try {
	c.result_text(() => "a\0b");
} catch (error) {
	nulRejected = error instanceof TypeError;
}
check(nulRejected, "terminated callback results reject embedded NUL");
for (const invoke of [c.result_bad_count, c.result_bad_count_async]) {
	let calls = 0;
	let rejected = false;
	try {
		await Promise.resolve(
			invoke(() => {
				calls++;
				return "text";
			}),
		);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(
		rejected && calls === 0,
		"null result-count pointers reject before JavaScript runs",
	);
}
console.log("callback results passed");
