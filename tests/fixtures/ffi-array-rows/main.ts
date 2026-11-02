/* oxlint-disable no-console -- The fixture reports observable C ABI behavior. */
import {
	char_rows_sum,
	sumCharRowsAsync,
	const_char_rows_sum,
	sumConstCharRowsAsync,
	char_grids_sum,
	sumCharGridsAsync,
	byte_rows_sum,
	sumByteRowsAsync,
	char_rows_make,
	makeCharRowsAsync,
	byte_rows_make,
	makeByteRowsAsync,
	char_rows_inout,
	inoutCharRowsAsync,
	byte_rows_inout,
	inoutByteRowsAsync,
	char_rows_fill,
	fillCharRowsAsync,
	char_rows_visit,
	visitCharRowsAsync,
	char_rows_notify,
	notifyCharRowsAsync,
	texts_notify,
	notifyTextsAsync,
	rows_notify,
	notifyAsync,
	rows_fill,
	rows_fill_visit,
	fillVisitAsync,
	fillAsync,
	rows_full,
	fullAsync,
	rows_inout,
	inoutAsync,
	rows_bad_count,
	badCountAsync,
	cells_inout,
	cellsInoutAsync,
	cells_fill,
	fillCellsAsync,
	rows_created,
	createdAsync,
	ints_fill,
	fillIntsAsync,
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
for (const capacity of [0n, 1n, 4n]) {
	for (const run of [rows_fill, fillAsync] as const) {
		const output = await run(capacity);
		const length = capacity === 0n ? 0n : capacity - 1n;
		check(
			output.written === length && output.values.length === Number(length),
			"caller buffers expose only the count C writes",
		);
		for (let i = 0; i < output.values.length; i++)
			check(
				output.values[i]!.join(",") === `${i * 10},${i * 10 + 1},${i * 10 + 2}`,
				"caller row contents use native stride",
			);
	}
	for (const run of [rows_full, fullAsync] as const)
		check(
			(await run(capacity)).values.length === Number(capacity),
			"a shared count and capacity stays a visible input",
		);
	for (const run of [cells_fill, fillCellsAsync] as const) {
		const output = await run(capacity);
		check(
			output.values.length === Number(capacity),
			"C initializes aligned const output rows",
		);
		for (let i = 0; i < output.values.length; i++)
			check(
				output.values[i]![0].value === i && output.values[i]![1].writable === 11,
				"const output rows preserve selected fields",
			);
	}
	for (const run of [ints_fill, fillIntsAsync] as const)
		check(
			(await run(capacity)).values.every((value, index) => value === index + 3),
			"caller capacities also support scalar arrays",
		);
	for (const run of [rows_created, createdAsync] as const) {
		const freed = rows_freed();
		const output = await run(capacity);
		check(
			output.values !== null &&
				output.values.length === Number(capacity) &&
				output.written === capacity &&
				rows_freed() === freed + 1,
			"C allocated array out parameters retain their free contract",
		);
	}
}
for (const run of [rows_inout, inoutAsync] as const) {
	const output = await run(rows);
	check(
		output.count === 1n &&
			output.values.length === 1 &&
			output.values[0]!.join(",") === "102,103,105",
		"inout snapshots use their input length as a capacity",
	);
	check(
		rows[0][0] === 2,
		"inout row conversion preserves the original JavaScript values",
	);
	check((await run([])).values.length === 0, "empty inout buffers return empty arrays");
}
for (const run of [cells_inout, cellsInoutAsync] as const) {
	const input: Array<[(typeof cells)[0][0], (typeof cells)[0][0]]> = [
		[
			{ value: 3, writable: 5 },
			{ value: 7, writable: 11 },
		],
		[
			{ value: 13, writable: 17 },
			{ value: 19, writable: 23 },
		],
	];
	const output = await run(input);
	check(
		output.count === 1n &&
			output.values[0]![0].value === 3 &&
			output.values[0]![0].writable === 105 &&
			input[0]![0].writable === 5,
		"const inout rows preserve immutable fields and copy mutable updates",
	);
}
for (const run of [rows_bad_count, badCountAsync] as const) {
	for (const capacity of [0n, 3n])
		for (const mode of [0, 1]) {
			let rejected = false;
			try {
				await run(capacity, mode);
			} catch (error) {
				rejected = error instanceof RangeError && error.message.includes("capacity");
			}
			check(
				rejected,
				"negative and over-capacity returned counts fail before buffer reads",
			);
		}
}
for (const run of [rows_fill, fillAsync] as const) {
	for (const invalid of [-1n, 1n << 31n, (1n << 64n) - 1n]) {
		const taken = rows_taken();
		let rejected = false;
		try {
			await run(invalid);
		} catch (error) {
			rejected = error instanceof RangeError;
		}
		check(rejected && rows_taken() === taken, "invalid capacities never enter C");
	}
}
for (const run of [rows_fill_visit, fillVisitAsync] as const) {
	let failed = false;
	try {
		await run(3n, () => {
			throw new Error("caller row callback failed");
		});
	} catch (error) {
		failed = error instanceof Error && error.message === "caller row callback failed";
	}
	check(failed, "callback failures retire caller array output storage");
}
check(
	(await fillAsync(2n)).values.length === 1,
	"caller array cleanup permits the next worker call",
);
for (const mode of [0, 1, 4]) {
	let delivered = false;
	await new Promise<void>((resolve) => {
		rows_notify(mode, (copiedRows, copiedCells) => {
			if (mode === 0) {
				check(
					copiedRows?.[1]?.join(",") === "7,11,13",
					"notification rows survive native stack reuse",
				);
				check(
					copiedCells?.[1]?.[0].value === 1 && copiedCells[1][1].writable === 11,
					"aligned const rows survive native storage release",
				);
			} else if (mode === 1) {
				check(
					copiedRows?.length === 0 && copiedCells?.length === 0,
					"non-null empty notification arrays stay empty",
				);
			} else {
				check(
					copiedRows === null && copiedCells === null,
					"null notification arrays stay null",
				);
			}
			delivered = true;
			resolve();
		});
		check(!delivered, "foreign notifications wait for the VM after the native join");
	});
	check(delivered, "notification is delivered after native callback release");
}
for (const mode of [2, 3]) {
	let rejected = false;
	let called = false;
	try {
		await notifyAsync(mode, () => {
			called = true;
		});
	} catch (error) {
		rejected = error instanceof RangeError;
	}
	check(
		rejected && !called,
		"invalid notification counts reject without reading array storage",
	);
}
let recovered = false;
await notifyAsync(0, (copiedRows) => {
	recovered = copiedRows?.[0]?.[0] === 2;
});
check(recovered, "copy errors leave later callback groups usable");
for (const mode of [0, 1, 4]) {
	await new Promise<void>((resolve) => {
		texts_notify(mode, (copied) => {
			if (mode === 0) {
				check(
					copied?.[0]?.[0] === "native text" &&
						copied[0][1] === null &&
						copied[0][2] === "",
					"notification text rows preserve null and empty entries",
				);
				check(
					copied?.[1]?.[0] === "caf\u00e9" &&
						copied[1][1] === "native text" &&
						copied[1][2] === null,
					"notification text survives native stack overwrite",
				);
			} else if (mode === 1) {
				check(copied?.length === 0, "empty text tables stay non-null");
			} else {
				check(copied === null, "null text tables stay null");
			}
			resolve();
		});
	});
}
for (const mode of [2, 3]) {
	let rejected = false;
	let called = false;
	try {
		await notifyTextsAsync(mode, () => {
			called = true;
		});
	} catch (error) {
		rejected = error instanceof RangeError;
	}
	check(rejected && !called, "invalid text table counts reject before touching pointers");
}
let textRecovered = false;
await notifyTextsAsync(0, (copied) => {
	textRecovered = copied?.[1]?.[0] === "caf\u00e9";
});
check(textRecovered, "text copy errors release the callback registration");
const nativeText = ["one", "caf\u00e9", ""];
for (const run of [
	char_rows_sum,
	sumCharRowsAsync,
	const_char_rows_sum,
	sumConstCharRowsAsync,
]) {
	check(
		(await run(nativeText)) === 8 && (await run([])) === 0,
		"fixed text rows use bounded UTF-8 bytes",
	);
}
check(
	char_grids_sum([["one", "two"]]) === 6 &&
		(await sumCharGridsAsync([["caf\u00e9", ""]])) === 5,
	"nested fixed grids retain text row boundaries",
);
const textSnapshot = ["one", "two"];
const textJob = sumCharRowsAsync(textSnapshot);
textSnapshot[0] = "changed";
check((await textJob) === 6, "workers snapshot fixed text before returning");
for (const invalid of ["12345678", "\u00e9\u00e9\u00e9\u00e9", "a\0b"]) {
	const before = rows_taken();
	let rejected = false;
	try {
		char_rows_sum([invalid]);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(
		rejected && rows_taken() === before,
		"invalid UTF-8 capacity or NUL input never enters C",
	);
}
check(
	char_rows_sum(["1234567", "\u00e9\u00e9\u00e9"]) === 13,
	"text capacity includes its terminator",
);
const rowBacking = new Uint8Array([90, 1, 2, 3, 4, 91]);
const rowView = rowBacking.subarray(1, 5);
for (const run of [byte_rows_sum, sumByteRowsAsync]) {
	check(
		(await run([rowView, new Uint8Array([5, 6, 7, 8])])) === 36,
		"fixed bytes accept exact subviews including zero bytes",
	);
}
for (const invalid of [new Uint8Array(3), new Uint8Array(5)]) {
	const before = rows_taken();
	let rejected = false;
	try {
		byte_rows_sum([invalid]);
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(
		rejected && rows_taken() === before,
		"byte rows enforce their native width before C",
	);
}
for (const run of [char_rows_make, makeCharRowsAsync]) {
	check(
		(await run(0, 2n))?.join(",") === "one,caf\u00e9",
		"C-owned text rows decode within each bound",
	);
	const before = rows_freed();
	let rejected = false;
	try {
		await run(1, 2n);
	} catch (error) {
		rejected = error instanceof RangeError;
	}
	check(
		rejected && rows_freed() === before + 1,
		"unterminated result rows release the outer allocation",
	);
}
for (const run of [byte_rows_make, makeByteRowsAsync]) {
	const copied = await run(2n);
	check(
		copied?.[0]?.join(",") === "0,1,2,3" && copied[1]?.join(",") === "10,11,12,13",
		"C byte rows return independent views",
	);
}
for (const run of [char_rows_inout, inoutCharRowsAsync]) {
	const result = await run(["one", "two"]);
	check(
		result.values.join(",") === "Xne" && result.count === 1n,
		"inout text rows decode the shortened output",
	);
}
for (const run of [byte_rows_inout, inoutByteRowsAsync]) {
	const result = await run([rowView, rowView]);
	check(
		result.values[0]?.join(",") === "101,2,3,4" &&
			result.count === 1n &&
			rowView[0] === 1,
		"inout byte rows keep input backing independent",
	);
}
for (const run of [char_rows_fill, fillCharRowsAsync]) {
	check(
		(await run(3n)).values.join(",") === "filled,filled" &&
			(await run(0n)).values.length === 0,
		"out text rows honor capacity and written count",
	);
}
for (const run of [char_rows_visit, visitCharRowsAsync] as const) {
	let visited = false;
	await run(["one", "caf\u00e9"], (values) => {
		visited = values?.join(",") === "one,caf\u00e9";
	});
	check(visited, "synchronous and waiting callbacks decode fixed text rows");
}
await new Promise<void>((resolve) => {
	char_rows_notify(0, (values) => {
		check(
			values?.join(",") === "one,caf\u00e9",
			"notifications own inline text rows after native release",
		);
		resolve();
	});
});
let invalidNotification = false;
let invalidCalled = false;
try {
	await notifyCharRowsAsync(1, () => {
		invalidCalled = true;
	});
} catch (error) {
	invalidNotification = error instanceof RangeError;
}
check(
	invalidNotification && !invalidCalled,
	"unterminated notification rows reject on the VM thread",
);
let charsRecovered = false;
await notifyCharRowsAsync(0, (values) => {
	charsRecovered = values?.[0] === "one";
});
check(charsRecovered, "bounded text failure leaves later groups usable");
console.log("array rows passed");
