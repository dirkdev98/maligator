/* oxlint-disable no-console -- The fixture reports observable C results. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	async_replace,
	async_replace_1,
	async_replace_1_async,
	async_replace_async,
	async_replaced_call,
	async_replaced_call_async,
	async_replace_keyed,
	async_replace_keyed_async,
	async_replaced_keyed_call_async,
	async_resource_async,
	async_resource_destroy,
	async_release_after_async,
	async_replace_data,
	async_replace_data_async,
	async_replaced_data_call_async,
} from "maligator:ffi/callbacks";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
check(
	async_replace_1((value) => value + 4) === 8,
	"scoped and replaced trampoline names coexist",
);
check(
	(await async_replace_1_async((value) => value + 5)) === 9,
	"async trampoline names coexist",
);
const trace: Array<string> = [];
let busy = false;
let refusedAsync: Promise<boolean> | undefined;
async_replace(0, (value) => {
	trace.push(`old:${value}`);
	try {
		async_replace(0, () => 99);
	} catch (error) {
		busy = error instanceof TypeError;
	}
	refusedAsync = async_replace_async(0, () => 99).then(
		() => false,
		(error: unknown) => error instanceof TypeError,
	);
	collect();
	return value + 1;
});
check(
	(await async_replace_async(1, (value) => {
		trace.push(`new:${value}`);
		collect();
		return value + 2;
	})) === 33,
	"C invokes the old and new no-data callbacks during replacement",
);
check(
	trace.join(",") === "old:10,new:20",
	"trampoline identity preserves both registrations",
);
check(busy && (await refusedAsync) === true, "both setter surfaces reject a pending key");
check(
	async_replace(1, (value) => value + 3) === 35,
	"sync setters replace async registrations",
);
check(
	(await async_replaced_call_async(5)) === 8,
	"the final callback remains registered",
);
await async_replace_async(0, null);
check(async_replaced_call(5) === 0, "null unregisters a no-data callback");

const marker = new Error("replacement callback failed");
async_replace(0, () => {
	throw marker;
});
let rejected = false;
try {
	await async_replace_async(1, (value) => value + 4);
} catch (error) {
	rejected = error === marker;
}
check(rejected, "an old callback exception rejects its active setter");
check(
	(await async_replaced_call_async(3)) === 7,
	"a committed replacement survives callback failure",
);
await async_replace_async(0, null);

async_replace_data(0, (value) => {
	collect();
	return value + 1;
});
check(
	(await async_replace_data_async(1, (value) => {
		collect();
		return value + 2;
	})) === 33,
	"user data distinguishes the old and new callback contexts",
);
collect();
check(
	(await async_replaced_data_call_async(5)) === 7,
	"user-data registrations survive settlement",
);
await async_replace_data_async(0, null);

const first = await async_resource_async(() => 0);
const second = await async_resource_async(() => 0);
check(first !== null && second !== null, "C creates independent keys");
async_replace_keyed(first, 0, (key, value) => {
	check(key === first, "the callback receives its canonical key");
	async_replace_keyed(second, 0, (_key, other) => other + 9);
	collect();
	return value + 1;
});
check(
	(await async_replace_keyed_async(first, 1, (key, value) => {
		check(key === first, "the replacement receives the same key");
		return value + 2;
	})) === 33,
	"a callback can configure a different key while its setter is pending",
);
check(
	(await async_replaced_keyed_call_async(second, 3)) === 12,
	"other keys keep their callbacks",
);
await async_replace_keyed_async(first, 0, null);
check(
	(await async_replaced_keyed_call_async(first, 3)) === 0,
	"a keyed callback can be cleared",
);
async_resource_destroy(first);
async_resource_destroy(second);

async_replace(0, (value) => value * 8);
const backlog = Array.from({ length: 256 }, (_, index) =>
	async_release_after_async(index, (value) => value),
);
let admission = false;
const refused = async_replace_async(0, () => 999).catch((error: unknown) => {
	admission = error instanceof Error && error.message.includes("could not be scheduled");
});
check(
	async_replaced_call(3) === 24,
	"failed admission leaves the old C registration intact",
);
await refused;
await Promise.allSettled(backlog);
check(admission, "replacement admission reports its scheduler failure");
await async_replace_async(0, null);
console.log("replaced async callbacks passed");
