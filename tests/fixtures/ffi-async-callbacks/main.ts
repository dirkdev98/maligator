/* oxlint-disable no-console -- The fixture reports observable C results. */
import { AsyncLocalStorage } from "node:async_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	async_apply_async,
	async_parallel_async,
	async_plain,
	async_plain_async,
	async_void_async,
	async_record_async,
	async_owned_async,
	async_resource_async,
	async_outputs_async,
	async_live,
	async_touch_async,
	async_bytes_count,
	async_bytes_count_async,
} from "maligator:ffi/callbacks";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
check(
	(await async_parallel_async(4, (value) => value * 2)) === 4848,
	"library-created threads receive callback results",
);
const plain = await Promise.all([
	async_plain_async(5, (value) => value + 1),
	async_plain_async(5, (value) => value * 2),
]);
check(
	plain.join(",") === "15,20",
	"callbacks without data are private to each worker call",
);
const inner = new Error("nested caught error");
check(
	(await async_plain_async(2, (value) => {
		try {
			async_plain(1, () => {
				throw inner;
			});
		} catch (error) {
			check(error === inner, "nested exception identity");
			return value + 2;
		}
		throw new Error("nested C callback must throw");
	})) === 5,
	"nested JavaScript catches retain their semantics",
);
let voidCalls = 0;
await async_void_async(4, () => {
	voidCalls++;
	collect();
});
check(voidCalls === 4, "void callbacks finish before the worker returns");
const record = await async_record_async(9, (value) => ({
	get x() {
		collect();
		return value;
	},
	get y() {
		collect();
		return value + 1;
	},
}));
check(record.x === 9 && record.y === 10, "record callback results survive getter GC");
const storage = new AsyncLocalStorage<string>();
const contextual = storage.run("ffi-context", () =>
	async_apply_async(3, (value) => {
		check(
			storage.getStore() === "ffi-context",
			"callback inherits its call's async context",
		);
		return value;
	}),
);
check(
	(await contextual) === 3 && storage.getStore() === undefined,
	"async context is restored after callbacks",
);
const marker = new Error("callback rejected this call");
let calls = 0;
const failed = async_apply_async(8, () => {
	calls++;
	throw marker;
}).then(
	() => false,
	(error: unknown) => error === marker,
);
const successful = async_apply_async(4, (value) => value);
check(await failed, "callback exception rejects its own promise");
check(
	calls === 1 && (await successful) === 6,
	"later callbacks stop without poisoning another call",
);
for (const invoke of [async_owned_async, async_resource_async, async_outputs_async]) {
	let rejected = false;
	try {
		await invoke(() => {
			throw marker;
		});
	} catch (error) {
		rejected = error === marker;
	}
	check(rejected && async_live() === 0, "owned C results release when a callback throws");
}
check(
	(await async_owned_async(() => 7)) === "owned" && async_live() === 0,
	"successful strings copy and release",
);
const resource = await async_resource_async(() => 7);
check(resource !== null && async_live() === 1, "successful handle owns its C resource");
resource[Symbol.dispose]();
check(async_live() === 0, "returned handle disposes once");
const bytes = new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 }));
check(
	(await async_touch_async(bytes, () => {
		check(bytes[0] === 42, "callback sees native byte writes");
		let refused = 0;
		try {
			bytes.buffer.transfer();
		} catch (error) {
			if (error instanceof TypeError) refused++;
		}
		try {
			bytes.buffer.resize(9);
		} catch (error) {
			if (error instanceof TypeError) refused++;
		}
		check(refused === 2, "callback cannot detach or resize the worker's buffer");
		return 65;
	})) === 8 && bytes[1] === 65,
	"C resumes with the callback result",
);
bytes.buffer.resize(12);
check(bytes.length === 12, "worker pins retire before promise fulfillment");
for (const count of [-1n, 0x100000000n]) {
	let syncRejected = false;
	let asyncRejected = false;
	try {
		async_bytes_count(count, () => {
			throw new Error("invalid bytes must not reach JavaScript");
		});
	} catch (error) {
		syncRejected = error instanceof RangeError;
	}
	try {
		await async_bytes_count_async(count, () => {
			throw new Error("invalid bytes must not reach JavaScript");
		});
	} catch (error) {
		asyncRejected = error instanceof RangeError;
	}
	check(syncRejected && asyncRejected, "callback counts reject before reading C memory");
}
console.log("async callbacks passed");
