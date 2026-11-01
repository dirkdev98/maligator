/* oxlint-disable no-console -- The fixture reports its results on standard output. */
import {
	SHAPES_BIG,
	SHAPES_BOTH,
	SHAPES_ORIGIN,
	SHAPES_SCALE,
	SHAPES_VERSION,
	shapes_add,
	shapes_area,
	shapes_bitmap_fill,
	shapes_bitmap_free,
	shapes_bitmap_new,
	shapes_bitmap_shared,
	shapes_allocations,
	shapes_bitmap_sum,
	shapes_bitmaps_live,
	shapes_bounds,
	shapes_call_return,
	shapes_canvas_create,
	shapes_canvas_current,
	shapes_canvas_draw,
	shapes_canvas_lend,
	shapes_canvas_on_draw,
	shapes_canvas_on_resize,
	shapes_canvas_open,
	shapes_canvas_resize,
	shapes_canvas_title,
	shapes_canvas_visit,
	shapes_canvases_open,
	shapes_checksum,
	shapes_contains,
	shapes_corners,
	shapes_describe,
	shapes_each,
	shapes_emit,
	shapes_fail,
	shapes_fill,
	shapes_fold,
	shapes_listen,
	shapes_listeners,
	shapes_unlisten_all,
	shapes_unregister_all,
	shapes_integrate,
	shapes_invoke,
	shapes_join,
	shapes_log_count,
	shapes_log_line,
	shapes_log_pair,
	shapes_mode_name,
	shapes_mul,
	shapes_pack,
	shapes_parse,
	shapes_read,
	shapes_register,
	shapes_render,
	shapes_scale,
	shapes_set_error_handler,
	shapes_sum2,
	shapes_sum3,
	shapes_text_bytes,
	shapes_text_runes,
	shapes_greeting,
	shapes_unsigned_max,
	shapes_total,
	shapes_twice,
} from "maligator:ffi/shapes";

const box = { min: { x: 0, y: 0 }, max: { x: 4, y: 3 } };
console.log(`add ${JSON.stringify(shapes_add({ x: 1, y: 2 }, { x: 3, y: 4.5 }))}`);
console.log(`area ${shapes_area(box)}`);
// Getters that allocate let a collection run between field reads.
const lazy = {
	get x() {
		return [1, 2, 3].length;
	},
	get y() {
		return { value: 2 }.value;
	},
};
const lazyBox = {
	get min() {
		return { x: 0, y: 0 };
	},
	max: { x: 2, y: 3 },
};
console.log(
	`getters ${JSON.stringify(shapes_add(lazy, { x: 1, y: 1 }))} ${shapes_area(lazyBox)}`,
);
const mixed = [
	{ x: 1, y: 2 },
	{ y: 5, x: -2 },
	{
		get x() {
			return [0].length - 1;
		},
		y: 3,
	},
];
console.log(`mixed ${JSON.stringify(shapes_bounds(mixed).box)}`);
const origin = { x: 0, y: 0 };
console.log(
	`other shapes ${JSON.stringify([
		shapes_add({ y: 2, x: 1 }, origin),
		shapes_add({ x: 1, y: 2, z: 3 } as { x: number; y: number }, origin),
		shapes_add(
			{
				get x() {
					return 5;
				},
				y: 1,
			},
			origin,
		),
	])}`,
);
console.log(
	`contains ${shapes_contains(box, { x: 1, y: 1 })} ${shapes_contains(box, { x: 9, y: 1 })}`,
);
console.log(`mode ${shapes_mode_name(SHAPES_BOTH)} ${shapes_mode_name(7)}`);
console.log(`total ${shapes_total(9007199254740993n, 1n)}`);
console.log(
	`sum ${shapes_sum3(1, 2, 3)} twice ${shapes_twice(21)} times max ${shapes_mul(3)} negative ${shapes_sum2(-5, 2)} unsigned ${shapes_unsigned_max() + 1}`,
);
console.log(
	`constants ${SHAPES_VERSION} ${SHAPES_SCALE} ${SHAPES_BIG} ${JSON.stringify(SHAPES_ORIGIN)}`,
);

{
	using canvas = shapes_canvas_open("Sketch");
	console.log(
		`canvas ${shapes_canvas_title(canvas)} ${shapes_canvas_title(null)} ${Object.prototype.toString.call(canvas)} open ${shapes_canvases_open()}`,
	);
}
console.log(`canvases after using ${shapes_canvases_open()}`);
console.log(
	`text bytes ${["Sketch", "Grüße", "🙂", "x".repeat(300)].map((text) => shapes_text_bytes(text)).join(",")}`,
);
console.log(
	`text runes ${["Sketch", "Grüße", "🙂", "x".repeat(300)].map((text) => shapes_text_runes(text)).join(",")} ${shapes_greeting()}`,
);
console.log(
	`log ${shapes_log_count("%d points", 3)} ${shapes_log_line()} ${shapes_log_pair("%s at %.1f", "origin", 2.5)} ${shapes_log_line()}`,
);
console.log(
	`join ${shapes_join(["one", "two", "three"])} ${shapes_join(["ab", "x".repeat(90)])?.length}`,
);
const filled = new Uint8Array(4);
let transferError = "";
const filledCount = shapes_fill(filled, () => {
	try {
		filled.buffer.transfer();
	} catch (error) {
		transferError = (error as Error).name;
	}
	return 0;
});
const moved = filled.buffer.transfer();
console.log(
	`fill ${filledCount} ${new Uint8Array(moved).join(",")} ${transferError} ${filled.buffer.detached}`,
);
const heard: Array<number> = [];
shapes_listen((event) => {
	heard.push(event);
});
shapes_listen((event) => {
	if (event === 3) throw new Error("listener failed");
});
shapes_emit(1);
shapes_emit(2);
let emitError = "";
try {
	shapes_emit(3);
} catch (error) {
	emitError = (error as Error).message;
}
const listening = shapes_listeners();
shapes_unlisten_all();
shapes_emit(4);
console.log(`listen ${heard.join(",")} ${emitError} ${listening} ${shapes_listeners()}`);
let readSeen = "";
const readResult = shapes_read((points, bytes) => {
	readSeen = `${JSON.stringify(points)} ${Array.from(bytes ?? []).join(",")}`;
	return points?.length ?? 0;
});
console.log(`read ${readResult} ${readSeen}`);
const immutable = (
	new Uint8Array([1, 2, 3]).buffer as unknown as { transferToImmutable(): ArrayBuffer }
).transferToImmutable();
console.log(`immutable checksum ${shapes_checksum(immutable)}`);
{
	using visited = shapes_canvas_open("Visited")!;
	let closeError = "";
	const titleLength = shapes_canvas_visit(visited, () => {
		try {
			visited[Symbol.dispose]();
		} catch (error) {
			closeError = (error as Error).message;
		}
	});
	console.log(`visit ${titleLength} ${closeError} ${shapes_canvas_title(visited)}`);
}
{
	using lender = shapes_canvas_open("Lender")!;
	let lent: Array<ReturnType<typeof shapes_canvas_open>> = [];
	shapes_canvas_lend(lender, (held, temporary) => {
		lent = [held, temporary];
	});
	let afterLend = "";
	try {
		shapes_canvas_title(lent[1]!);
	} catch (error) {
		afterLend = (error as Error).message;
	}
	console.log(`lend ${lent[0] === lender} ${shapes_canvas_title(lent[0]!)} ${afterLend}`);
}
// Literals and struct results that C calls keep on the stack, before and after one
// escapes to the heap.
function lendLiterals(kept: Array<{ x: number; y: number }>): string {
	const point = { x: 1, y: 2 };
	const first = shapes_add(point, { x: 10, y: 10 });
	point.x = 5;
	const second = shapes_add(point, point);
	kept.push(point);
	point.y = 7;
	const third = shapes_add(point, { x: 0, y: 0 });
	const fourth = shapes_add(third, third);
	kept.push(fourth);
	return `${first.x},${first.y} ${second.x},${second.y} ${third.x},${third.y} ${kept[0]!.y} ${fourth.x} ${JSON.stringify(kept[1])}`;
}
console.log(`lend literals ${lendLiterals([])}`);
// Two literals that reach one register, each observed on some path, lend to one call.
function lendEither(first: boolean, observed: boolean, kept: Array<unknown>): number {
	let point: { x: number; y: number };
	if (first) {
		const a = { x: 1, y: 2 };
		kept.push(a.x);
		kept.push(a);
		point = a;
	} else {
		const b = { x: 3, y: 4 };
		kept.push(b.x);
		if (observed) kept.push(b);
		point = b;
	}
	return shapes_add(point, { x: 0, y: 1 }).y;
}
console.log(
	`lend either ${lendEither(true, false, [])} ${lendEither(false, false, [])} ${lendEither(false, true, [])}`,
);
const packed = new Uint8Array(8);
const packing = shapes_pack(packed, new Uint8Array([4, 5, 6]));
console.log(
	`pack ${packing.result} ${packing.destLen} ${packed.slice(0, Number(packing.destLen)).join(",")} ${shapes_pack(new Uint8Array(2), new Uint8Array(3)).result}`,
);
const failures: Array<string> = [];
shapes_set_error_handler((code, message) => {
	failures.push(`a${code}:${message}`);
});
shapes_fail(1);
shapes_set_error_handler((code) => {
	failures.push(`b${code}`);
	if (code === 3) throw new Error("handler failed");
});
shapes_fail(2);
let failError = "";
try {
	shapes_fail(3);
} catch (error) {
	failError = (error as Error).message;
}
shapes_set_error_handler(null);
shapes_fail(4);
console.log(`replaced ${failures.join(",")} ${failError}`);
{
	using first = shapes_canvas_open("First")!;
	using second = shapes_canvas_open("Second")!;
	const resized: Array<string> = [];
	shapes_canvas_on_resize(first, (canvas, width, height) => {
		resized.push(`${canvas === first}:${width}x${height}`);
	});
	shapes_canvas_on_resize(second, (canvas, width) => {
		resized.push(`${shapes_canvas_title(canvas)} ${width}`);
	});
	shapes_canvas_resize(first, 2, 3);
	shapes_canvas_resize(second, 4, 5);
	shapes_canvas_on_resize(first, (_, width) => {
		resized.push(`again ${width}`);
	});
	shapes_canvas_resize(first, 6, 7);
	shapes_canvas_on_draw(first, (frame) => frame * 2);
	const drawn = [shapes_canvas_draw(first, 5)];
	shapes_canvas_on_draw(first, (frame) => frame + 100);
	drawn.push(shapes_canvas_draw(first, 5), shapes_canvas_draw(second, 5));
	console.log(`per handle ${resized.join(",")} ${drawn.join(",")}`);
}
shapes_register("hypot", (call, args) => {
	shapes_call_return(call!, Math.hypot(args![0]!, args![1]!));
});
shapes_register("sum", (call, args) => {
	shapes_call_return(
		call!,
		args!.reduce((total, value) => total + value, 0),
	);
});
const invoked = [shapes_invoke("hypot", 3, 4), shapes_invoke("sum", 2, 5)];
let keptCall: Parameters<typeof shapes_call_return>[0] | null = null;
shapes_register("sum", (call) => {
	keptCall = call;
	shapes_call_return(call!, -2);
});
invoked.push(shapes_invoke("sum", 2, 5), shapes_invoke("missing", 0, 0));
let afterCall = "";
try {
	shapes_call_return(keptCall!, 1);
} catch (error) {
	afterCall = (error as Error).message;
}
shapes_unregister_all();
console.log(`lookup ${invoked.join(",")} ${afterCall}`);
const opened = shapes_canvas_open("Same");
console.log(`same handle ${opened === shapes_canvas_current()}`);
shapes_canvas_current()?.[Symbol.dispose]();
console.log(
	`closed through either ${shapes_canvases_open()} ${shapes_canvas_current() === null}`,
);

const bitmap = shapes_bitmap_new(3, 2);
shapes_bitmap_fill(bitmap, 4);
console.log(
	`bitmap ${bitmap.width}x${bitmap.height} sum ${shapes_bitmap_sum(bitmap)} live ${shapes_bitmaps_live()}`,
);
shapes_bitmap_free(bitmap);
console.log(`bitmaps after free ${shapes_bitmaps_live()}`);
const shared = shapes_bitmap_shared();
shared[Symbol.dispose]();
console.log(`shared after dispose ${shapes_bitmap_sum(shapes_bitmap_shared())}`);

console.log(
	`parse ${JSON.stringify(shapes_parse("3,4"))} ${shapes_parse("nope").result}`,
);
console.log(`scale ${JSON.stringify(shapes_scale({ x: 1, y: 2 }, 3))}`);
console.log(
	`bounds ${JSON.stringify(
		shapes_bounds([
			{ x: 1, y: 5 },
			{ x: -2, y: 3 },
		]),
	)} ${shapes_bounds([]).result}`,
);
console.log(
	`checksum ${shapes_checksum(new Uint8Array([1, 2, 3, 250]))} ${shapes_checksum(new Uint8Array([7, 8, 9]).subarray(1).buffer)}`,
);
const rendered = shapes_render(4, 2);
console.log(`render ${rendered?.length} ${rendered?.join(",")}`);
console.log(`corners ${JSON.stringify(shapes_corners(box))}`);
console.log(`describe ${shapes_describe({ x: 1.5, y: -2 })}`);
const created = shapes_canvas_create("Created");
console.log(`created ${created.result} ${shapes_canvas_title(created.canvas)}`);
created.canvas?.[Symbol.dispose]();
console.log(`allocations ${shapes_allocations()} canvases ${shapes_canvases_open()}`);

const visited: Array<string> = [];
const stopped = shapes_each(
	[
		{ x: 1, y: 2 },
		{ x: 3, y: 4 },
		{ x: 5, y: 6 },
	],
	(point, index) => {
		visited.push(`${index}:${point.x}`);
		return point.x >= 3 ? 1 : 0;
	},
);
console.log(`each ${stopped} ${visited.join(",")}`);
console.log(`integrate ${shapes_integrate((x) => x * x, 0, 3, 3000).toFixed(4)}`);
// A callback without user data, with a nested call of the same function.
console.log(
	`fold ${shapes_fold(4, (acc, index) => acc + index * shapes_fold(2, (inner, step) => inner + step + 1))}`,
);
let calls = 0;
try {
	shapes_each([origin, origin, origin], () => {
		calls++;
		throw new Error("stop here");
	});
} catch (error) {
	console.log(`callback threw ${(error as Error).message} after ${calls} call`);
}

const rejected = [
	() => shapes_each([], 5 as unknown as () => number),
	() => shapes_checksum("bytes" as unknown as Uint8Array),
	() => shapes_checksum(new SharedArrayBuffer(4)),
	() => shapes_bounds([{ x: 1 } as unknown as { x: number; y: number }]),
	() => shapes_bitmap_sum(bitmap),
	() => shapes_canvas_title({} as unknown as ReturnType<typeof shapes_canvas_open>),
	() => shapes_twice(1.5),
	() => shapes_twice("2" as unknown as number),
	() => shapes_total(1 as unknown as bigint, 1n),
	() => shapes_add({ x: 1 } as unknown as { x: number; y: number }, { x: 0, y: 0 }),
	() => shapes_text_bytes("a\0b"),
	() => shapes_log_count("%d", 1.5),
	() => shapes_fill(new Uint8Array(immutable), () => 0),
	// The same bad field with and without the box's shape, so both read paths throw.
	() => shapes_area({ min: { x: 0, y: 0 }, max: { x: 1, y: "1" as unknown as number } }),
	() => shapes_area({ min: { x: 0, y: 0 }, max: { y: "1" as unknown as number, x: 1 } }),
];
for (const call of rejected) {
	try {
		call();
		console.log("accepted");
	} catch (error) {
		console.log(`rejected ${(error as Error).name}: ${(error as Error).message}`);
	}
}
