/* oxlint-disable no-console -- The fixture reports observable C results. */
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	async_register_async,
	async_register_lookup_async,
	async_resource_value,
	async_registered_call_async,
	async_registered_clear,
	async_registered_clear_async,
	async_registered_count,
	async_notify_async,
	async_release_after_async,
	async_release_buffer_async,
} from "maligator:ffi/callbacks";
import type { AsyncResource } from "maligator:ffi/callbacks";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
await async_register_async(0, (value) => value * 7);
collect();
check(async_registered_count() === 1, "C retains the registration after settlement");
check(
	(await async_registered_call_async(6)) === 42,
	"retained callback returns on a later worker",
);
await async_registered_clear_async();
check(async_registered_count() === 0, "C release retires the registration");

let loan: AsyncResource | null = null;
await async_register_lookup_async(0, (resource) => {
	check(resource !== null, "C supplies a callback context");
	loan = resource;
	collect();
	return async_resource_value(resource) + 1;
});
collect();
check(
	(await async_registered_call_async(8)) === 9,
	"lookup routes a retained callback after registration settles",
);
check(loan !== null, "the callback receives a handle loan");
let closedLoan = false;
try {
	async_resource_value(loan);
} catch (error) {
	closedLoan = error instanceof TypeError;
}
check(closedLoan, "a waiting callback's handle loan ends before C resumes");
await async_registered_clear_async();

check(
	(await async_register_async(2, (value) => {
		collect();
		return value + 1;
	})) === 12 && async_registered_count() === 0,
	"immediate native release preserves the pending call's callback reference",
);
check(
	(await async_register_async(1, (value) => {
		async_registered_clear();
		collect();
		return value + 2;
	})) === 13 && async_registered_count() === 0,
	"release from the callback preserves its active invocation",
);

const marker = new Error("retained registration failed");
let first = true;
let rejected = false;
try {
	await async_register_async(1, (value) => {
		if (first) {
			first = false;
			throw marker;
		}
		collect();
		return value + 3;
	});
} catch (error) {
	rejected = error === marker;
}
check(rejected, "a registration callback rejects its own promise");
check(
	(await async_registered_call_async(4)) === 7,
	"a retained registration survives its call's exception group",
);
await async_registered_clear_async();
check(
	(await async_register_async(0, null)) === 0 && async_registered_count() === 0,
	"null registration has no retained callback",
);

const delivered = new Promise<number>((resolve, reject) => {
	async_notify_async((value) => {
		collect();
		resolve(value);
	}).catch(reject);
});
check((await delivered) === 17, "queued notifications survive immediate native release");

const weak: Array<WeakRef<(value: number) => number>> = [];
async function invalidBuffer(): Promise<void> {
	const callback = (value: number) => value;
	weak.push(new WeakRef(callback));
	let refused = false;
	try {
		await async_release_buffer_async(callback, "invalid" as unknown as Uint8Array);
	} catch (error) {
		refused = error instanceof TypeError;
	}
	check(refused, "a conversion after retaining the callback rejects without entering C");
}
await invalidBuffer();
function submit(value: number): Promise<number> {
	const callback = (input: number) => input + 1;
	weak.push(new WeakRef(callback));
	return async_release_after_async(value, callback);
}
const results = await Promise.allSettled(
	Array.from({ length: 256 }, (_, index) => submit(index)),
);
check(
	results.some((result) => result.status === "rejected"),
	"bounded admission rejects excess registrations before C starts",
);
check(
	results.every((result, index) =>
		result.status === "fulfilled"
			? result.value === index + 1
			: result.reason instanceof Error &&
				result.reason.message.includes("could not be scheduled"),
	),
	"accepted callbacks complete and rejected calls preserve their scheduling error",
);
await new Promise<void>((resolve) => {
	setTimeout(resolve, 0);
});
collect();
check(
	weak.every((reference) => reference.deref() === undefined),
	"conversion, admission and C release all retire callback roots",
);
console.log("retained async callbacks passed");
