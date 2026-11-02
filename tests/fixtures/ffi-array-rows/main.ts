/* oxlint-disable no-console -- The fixture reports observable C ABI behavior. */
import {
	rows_sum,
	rows_bump,
	bumpAsync,
	sumAsync,
	grids_sum,
	gridsAsync,
	cells_sum,
	cellsAsync,
	choices_sum,
	choicesAsync,
	tokens_sum,
	tokensAsync,
	row_token_make,
	row_token_destroyed,
	rows_make,
	makeRowsAsync,
	cells_make,
	makeCellsAsync,
	tags_make,
	makeTagsAsync,
	rows_freed,
	rows_taken,
	rows_visit,
	visitAsync,
} from "maligator:ffi/array_rows";
function check(value: boolean, message: string): asserts value {
	if (!value) throw new Error(message);
}
const rows: [[number, number, number], [number, number, number]] = [
	[2, 3, 5],
	[7, 11, 13],
];
for (const run of [rows_sum, sumAsync]) {
	check(
		(await run(rows)) === 41 && (await run([])) === 0 && (await run(null)) === 0,
		"counted rows keep their inner bound and nullable outer pointer",
	);
}
check(
	rows_bump(rows) === 61 && (await bumpAsync(rows)) === 61 && rows[0][0] === 2,
	"mutable row inputs use isolated native copies",
);
check(
	grids_sum([rows]) === 41 && (await gridsAsync([rows])) === 41,
	"deeper native array dimensions remain fixed",
);
const cells: Array<
	[{ value: number; writable: number }, { value: number; writable: number }]
> = [
	[
		{ value: 3, writable: 5 },
		{ value: 7, writable: 11 },
	],
];
check(cells_sum(cells) === 26, "const record rows use aligned native copies");
const pending = cellsAsync(cells);
cells[0]![0].value = 1000;
check((await pending) === 26, "workers snapshot every const field in nested rows");
check(
	choices_sum([
		[
			[2, 3],
			[5, 7],
		],
	]) === 17 &&
		(await choicesAsync([
			[
				[11, 13],
				[17, 19],
			],
		])) === 60,
	"shape overrides reach union leaves through fixed arrays",
);
const withGetters = [rows[0], rows[1]];
Object.defineProperty(withGetters, 1, {
	get() {
		const row: [number, number, number] = [7, 11, 13];
		Object.defineProperty(row, 0, {
			get() {
				const garbage = Array.from({ length: 16 }, () => ({ value: "row roots" }));
				check(garbage.length === 16, "allocating inner getter");
				return 7;
			},
		});
		return row;
	},
});
check(rows_sum(withGetters) === 41, "fresh inner arrays stay rooted through conversion");
for (const invalid of [[[1, 2]], [[1, 2, 3, 4]], [[1, 2, 1.5]]]) {
	const before = rows_taken();
	let rejected = false;
	try {
		rows_sum(invalid as Array<[number, number, number]>);
	} catch (error) {
		rejected = error instanceof Error;
	}
	check(
		rejected && rows_taken() === before,
		"invalid inner dimensions and elements never enter C",
	);
}
const first = row_token_make(3);
const second = row_token_make(5);
const tokenRow: [typeof first, typeof second] = [first, second];
Object.defineProperty(tokenRow, 1, {
	get() {
		let pinned = false;
		try {
			first[Symbol.dispose]();
		} catch (error) {
			pinned = error instanceof TypeError;
		}
		check(pinned, "earlier copied handles stay pinned through inner getters");
		return second;
	},
});
check(
	tokens_sum([tokenRow]) === 18 && (await tokensAsync([tokenRow])) === 18,
	"nested const copied handles preserve their ownership",
);
const beforeBadToken = rows_taken();
let badToken = false;
try {
	tokens_sum([[first, {} as typeof second]]);
} catch (error) {
	badToken = error instanceof TypeError;
}
check(
	badToken && rows_taken() === beforeBadToken,
	"failed nested handle conversion never enters C",
);
const destroyed = row_token_destroyed();
first[Symbol.dispose]();
second[Symbol.dispose]();
check(
	row_token_destroyed() === destroyed + 2,
	"array staging creates no extra native owners",
);
for (const count of [0n, 1n, 3n]) {
	for (const run of [rows_make, makeRowsAsync]) {
		const freed = rows_freed();
		const result = await run(count);
		check(
			result !== null && result.length === Number(count),
			"copies a C allocated outer array",
		);
		for (let i = 0; i < result.length; i++)
			check(
				result[i]!.join(",") === `${i * 10},${i * 10 + 1},${i * 10 + 2}`,
				"C row results preserve all inner elements",
			);
		check(rows_freed() === freed + 1, "native row results release their allocation once");
	}
	for (const run of [cells_make, makeCellsAsync]) {
		const result = await run(count);
		check(
			result !== null && result.length === Number(count),
			"copies const record rows from C",
		);
		for (let i = 0; i < result.length; i++)
			check(
				result[i]![0].value === i && result[i]![1].writable === 11,
				"nested const result fields survive allocation",
			);
	}
}
for (const run of [tags_make, makeTagsAsync]) {
	const freed = rows_freed();
	let failed = false;
	try {
		await run(1, 3n);
	} catch (error) {
		failed = error instanceof TypeError;
	}
	check(
		failed && rows_freed() === freed + 1,
		"nested conversion failure still releases the native outer array",
	);
	const recovered = await run(0, 2n);
	check(
		recovered !== null && recovered[1]![1].payload === 2,
		"root cleanup permits a later nested result",
	);
}
for (const run of [rows_visit, visitAsync] as const) {
	let sum = 0;
	await run(rows, (received) => {
		check(received !== null, "callback gets a counted outer array");
		sum = rows_sum(received);
	});
	check(sum === 41, "synchronous and waiting callbacks copy nested counted arrays");
}
console.log("array rows passed");
