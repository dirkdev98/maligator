/* oxlint-disable no-console -- Reports observable resource-array ownership. */
import * as c from "maligator:ffi/arrays";
import { createWorkerUrl, Worker } from "maligator:workers";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
function dispose(values: ReadonlyArray<c.ArrayResource | null>): void {
	for (const value of new Set(values)) value?.[Symbol.dispose]();
}
async function catches(action: () => unknown): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error("expected conversion failure");
}
for (const invoke of [c.array_make, c.makeAsync]) {
	for (const count of [0, 1, 3, 257]) {
		const created = c.resources_created(),
			destroyed = c.resources_destroyed(),
			freed = c.arrays_freed();
		const result = await invoke(count, 0);
		check(
			result.message === "x" && result.result!.length === count,
			"success preserves count and copied fields",
		);
		for (let index = 1; index < count; index += 2)
			check(
				result.result![index] === result.result![index - 1],
				"duplicate entries retain canonical identity",
			);
		if (count > 4)
			check(result.result![4] === null, "null entries retain their position");
		dispose(result.result!);
		check(
			c.resources_destroyed() - destroyed === c.resources_created() - created &&
				c.arrays_freed() === freed + 1,
			"success transfers every unique element and releases outer storage once",
		);
	}
	const created = c.resources_created(),
		destroyed = c.resources_destroyed();
	check(
		(await catches(() => invoke(3, 1))) instanceof RangeError,
		"late conversion preserves its error",
	);
	check(
		c.resources_destroyed() - destroyed === c.resources_created() - created,
		"late conversion releases every unique element",
	);
}
for (const invoke of [c.array_alias, c.aliasAsync]) {
	const freed = c.arrays_freed();
	const result = await invoke();
	check(
		result.result![0] === result.other![0] && result.result![2] === result.other![2],
		"aliased arrays share element identities",
	);
	check(
		c.arrays_freed() === freed + 1,
		"aliased outer buffers release once after both copies",
	);
	dispose(result.result!);
}
for (const invoke of [c.array_mixed, c.mixedAsync]) {
	const result = await invoke(0);
	check(result.result === result.out![2], "direct and array outputs share ownership");
	dispose(result.out!);
	const created = c.resources_created(),
		destroyed = c.resources_destroyed();
	check(
		(await catches(() => invoke(1))) instanceof RangeError,
		"mixed late conversion retains its error",
	);
	check(
		c.resources_destroyed() - destroyed === c.resources_created() - created,
		"mixed direct and array aliases release once",
	);
}
for (const invoke of [c.array_null, c.nullAsync])
	check((await invoke()) === null, "null arrays ignore an unusable count");
for (const invoke of [c.array_fail, c.failAsync]) {
	let callbacks = 0;
	c.array_watch(() => {
		callbacks++;
	});
	const created = c.resources_created(),
		destroyed = c.resources_destroyed(),
		failures = c.allocation_failures();
	const error = await catches(() => invoke(0));
	c.allocation_reset();
	c.array_watch(null);
	check(callbacks === 0, "pending allocation error prevents cleanup callback reentry");
	check(
		error instanceof Error && error.message === "Out of memory",
		"claim storage failure throws allocation error",
	);
	check(
		c.allocation_failures() === failures + 1 &&
			c.resources_destroyed() - destroyed === c.resources_created() - created,
		"allocation-free fallback releases unique elements",
	);
}
{
	const marker = new Error("array callback marker");
	const created = c.resources_created(),
		destroyed = c.resources_destroyed(),
		failures = c.allocation_failures();
	check(
		(await catches(() =>
			c.array_callback(() => {
				throw marker;
			}),
		)) === marker,
		"pending callback error survives cleanup fallback",
	);
	c.allocation_reset();
	check(
		c.allocation_failures() === failures &&
			c.resources_destroyed() - destroyed === c.resources_created() - created,
		"pending errors skip claim allocation and release all elements",
	);
}
const failNextCell = (
	globalThis as typeof globalThis & { __mal_fail_next_cell_allocation?: () => void }
).__mal_fail_next_cell_allocation;
if (failNextCell !== undefined) {
	const prior = c.resource_borrow(51)!;
	const created = c.resources_created(),
		destroyed = c.resources_destroyed();
	const error = await catches(() => c.array_existing(prior, failNextCell));
	check(
		error instanceof Error && error.message === "Out of memory",
		"later element conversion allocation failure is observable",
	);
	check(
		c.resource_value(prior) === 51 &&
			c.resources_destroyed() - destroyed === c.resources_created() - created,
		"partial conversion preserves prior alias and frees only new elements",
	);
	prior[Symbol.dispose]();
	check(
		c.resources_destroyed() - destroyed === c.resources_created() - created,
		"partial conversion preserves borrowed ownership",
	);
	c.resource_clear();
}
for (const invoke of [c.buffer_alias, c.bufferAliasAsync]) {
	const first = c.buffer_first_frees(),
		second = c.buffer_second_frees();
	const result = await invoke();
	check(
		result.result === "x" && result.other === "x",
		"all aliases copy before release mutates storage",
	);
	check(
		c.buffer_first_frees() === first + 1 && c.buffer_second_frees() === second,
		"aliased allocations use their first release policy once",
	);
}

for (const invoke of [c.array_existing_bad, c.existingBadAsync]) {
	const prior = c.resource_borrow(63)!;
	const created = c.resources_created(),
		destroyed = c.resources_destroyed();
	check(
		(await catches(() => invoke(prior, 1))) instanceof RangeError,
		"partial array conversion retains the later output error",
	);
	check(
		c.resource_value(prior) === 63 &&
			c.resources_destroyed() - destroyed === c.resources_created() - created,
		"late output failure preserves an existing array alias",
	);
	prior[Symbol.dispose]();
	check(
		c.resources_destroyed() - destroyed === c.resources_created() - created,
		"late output failure does not acquire prior borrowed ownership",
	);
	c.resource_clear();
}
{
	const old = c.resource_recycled()!;
	let result: ReturnType<typeof c.array_fresh> | undefined;
	c.resource_on_destroy(() => {
		result = c.array_fresh();
	});
	c.resource_free(old);
	c.resource_on_destroy(null);
	check(
		result !== undefined &&
			result.result === result.out![0] &&
			c.resource_value(result.result!) === 73,
		"borrowed fresh result replaces a closing lifetime before array conversion",
	);
	dispose(result.out!);
}
{
	const old = c.resource_recycled()!;
	const created = c.resources_created(),
		destroyed = c.resources_destroyed(),
		failures = c.allocation_failures();
	c.resource_on_destroy(() => {
		c.array_fresh_fail();
	});
	const error = await catches(() => c.resource_free(old));
	c.resource_on_destroy(null);
	c.allocation_reset();
	check(
		error instanceof Error &&
			error.message === "Out of memory" &&
			c.allocation_failures() === failures + 1,
		"fresh array fallback retains allocation error",
	);
	check(
		c.resources_destroyed() - destroyed === c.resources_created() - created + 1,
		"borrowed fresh hint permits one new lifetime cleanup during fallback",
	);
}
for (const invoke of [c.array_single, c.singleAsync]) {
	const created = c.resources_created(),
		destroyed = c.resources_destroyed();
	const marker = new Error("array release marker");
	c.array_watch(() => {
		c.array_register(() => c.array_peek(0)!);
		throw marker;
	});
	check(
		(await catches(() => invoke(3))) === marker,
		"array release preserves a callback error",
	);
	c.array_watch(null);
	check(
		c.array_registered_value() === 17 &&
			c.resources_destroyed() - destroyed < c.resources_created() - created,
		"native result lease preserves an abandoned array element",
	);
	c.array_register(null);
	check(
		c.resources_destroyed() - destroyed === c.resources_created() - created,
		"last native lease releases an abandoned manual array element",
	);
}

const collect = (globalThis as typeof globalThis & { __mal_collect_garbage?: () => void })
	.__mal_collect_garbage;
check(typeof collect === "function", "native fixture supplies forced collection");
for (const invoke of [c.array_single, c.singleAsync]) {
	c.array_watch(collect);
	const result = await invoke(3);
	c.array_watch(null);
	check(
		result!.length === 3 && c.resource_value(result![0]!) === 17,
		"array results stay rooted through cleanup callbacks",
	);
	dispose(result!);
}
for (const invoke of [c.buffer_single, c.bufferSingleAsync]) {
	c.array_watch(collect);
	const result = await invoke(5);
	c.array_watch(null);
	check(
		result !== null && result.length === 127 && result.charCodeAt(0) === 102,
		"standalone copied strings stay rooted through cleanup callbacks",
	);
}

const created = c.resources_created(),
	destroyed = c.resources_destroyed(),
	freed = c.arrays_freed();
const worker = new Worker(createWorkerUrl("./abandon.ts", import.meta.url));
const admitted = new Promise<unknown>((resolve) => {
	worker.port.onmessage = (event) => resolve(event.data);
});
worker.port.start();
await worker.ready;
worker.port.postMessage(null);
check((await admitted) === "admitted", "worker admitted array operation");
while (c.array_started() === 0)
	await new Promise((resolve) => {
		setTimeout(resolve, 1);
	});
await worker.terminate();
check(
	c.resources_created() > created &&
		c.resources_destroyed() - destroyed === c.resources_created() - created &&
		c.arrays_freed() === freed + 1,
	"native abandonment releases every unique element and outer buffer",
);
console.log("resource arrays passed");
