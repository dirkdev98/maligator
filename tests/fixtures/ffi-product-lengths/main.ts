/* oxlint-disable no-console -- The fixture reports buffer length validation. */
import {
	fillPixelsAsync,
	fill_pixels,
	grid_calls,
	sum_grid,
	sumGridAsync,
} from "maligator:ffi/grid";

function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}

async function rejectsBeforeC(run: () => unknown, message: string): Promise<void> {
	const calls = grid_calls();
	let caught: unknown;
	try {
		await run();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof RangeError, `${message}: ${String(caught)}`);
	check(grid_calls() === calls, `${message}: C ran`);
}

const pixels = new Uint8Array(24);
check(fill_pixels(2, 3, pixels) === 24, "exact buffer");
check(pixels[0] === 1 && pixels[23] === 24, "C filled the buffer");
const larger = new Uint8Array(30);
check(
	fill_pixels(2, 3, larger) === 24 && larger[24] === 0,
	"a larger buffer keeps its tail",
);
check(
	fill_pixels(0, 3, new Uint8Array(0)) === 0,
	"an empty product accepts an empty buffer",
);
await rejectsBeforeC(() => fill_pixels(2, 3, new Uint8Array(23)), "short buffer");
await rejectsBeforeC(() => fill_pixels(-1, 3, new Uint8Array(24)), "negative factor");
check((await fillPixelsAsync(2, 3, new Uint8Array(24))) === 24, "async exact buffer");
await rejectsBeforeC(
	() => fillPixelsAsync(2, 3, new Uint8Array(8)),
	"async short buffer",
);

check(sum_grid([1, 2, 3, 4, 5, 6], 2, 3) === 21, "array grid");
check(
	sum_grid(new Float64Array([1, 2, 3, 4, 5, 6, 7]), 2, 3) === 21,
	"typed grid with spare elements",
);
await rejectsBeforeC(() => sum_grid([1, 2, 3], 2, 3), "short array");
await rejectsBeforeC(() => sum_grid(new Float64Array(5), 2, 3), "short typed array");
check((await sumGridAsync([1, 2, 3, 4], 2, 2)) === 10, "async grid");
await rejectsBeforeC(() => sumGridAsync([1], 2, 2), "async short array");

console.log("product lengths passed");
