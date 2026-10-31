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
	shapes_canvas_create,
	shapes_canvas_current,
	shapes_canvas_open,
	shapes_canvas_title,
	shapes_canvases_open,
	shapes_checksum,
	shapes_contains,
	shapes_corners,
	shapes_describe,
	shapes_each,
	shapes_integrate,
	shapes_join,
	shapes_log_count,
	shapes_log_line,
	shapes_log_pair,
	shapes_mode_name,
	shapes_mul,
	shapes_parse,
	shapes_render,
	shapes_scale,
	shapes_sum3,
	shapes_text_bytes,
	shapes_total,
	shapes_twice,
} from "maligator:ffi/shapes";

const box = { min: { x: 0, y: 0 }, max: { x: 4, y: 3 } };
console.log(`add ${JSON.stringify(shapes_add({ x: 1, y: 2 }, { x: 3, y: 4.5 }))}`);
console.log(`area ${shapes_area(box)}`);
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
	`sum ${shapes_sum3(1, 2, 3)} twice ${shapes_twice(21)} times max ${shapes_mul(3)}`,
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
	`log ${shapes_log_count("%d points", 3)} ${shapes_log_line()} ${shapes_log_pair("%s at %.1f", "origin", 2.5)} ${shapes_log_line()}`,
);
console.log(
	`join ${shapes_join(["one", "two", "three"])} ${shapes_join(["ab", "x".repeat(90)])?.length}`,
);
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
];
for (const call of rejected) {
	try {
		call();
		console.log("accepted");
	} catch (error) {
		console.log(`rejected ${(error as Error).name}: ${(error as Error).message}`);
	}
}
