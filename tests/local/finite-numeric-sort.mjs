function sortFinite(values, reverse, copy) {
	const ascending = (a, b) => a - b;
	const descending = (a, b) => b - a;
	let compare = ascending;
	if (reverse) compare = descending;
	return copy ? values.toSorted(compare) : values.sort(compare);
}

function show(values) {
	return Array.from(values, (value) =>
		Object.is(value, -0) ? "-0" : String(value),
	).join(",");
}

if (process.env.FINITE_SORT_CASE === "fallback") {
	const nan = new Float64Array([NaN, -0, 3, 0, -2]);
	console.log("nan-ties", show(nan.toSorted((a, b) => (a - a) / (b - b))));
	console.log(
		"bigint",
		show(
			new BigInt64Array([3n, -1n, 2n]).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		),
	);
	try {
		sortFinite(new BigInt64Array([3n, 1n]), false, false);
	} catch (error) {
		console.log("bigint-number", error.name);
	}
	const calls = [];
	const replacement = {
		sort(compare) {
			calls.push(compare(4, 2));
			return "replaced";
		},
		toSorted(compare) {
			calls.push(compare(4, 2));
			return "copied";
		},
	};
	console.log(
		"replacement",
		sortFinite(replacement, false, false),
		sortFinite(replacement, true, true),
		calls.join(","),
	);
	const source = new Float64Array([3, 1, 2]);
	let comparisons = 0;
	try {
		source.sort((a, b) => {
			comparisons++;
			source[0] = 99;
			throw new Error("comparison");
		});
	} catch (error) {
		console.log("throw", error.message, comparisons, show(source));
	}
} else {
	for (const Type of [Float64Array, Float32Array, Int32Array]) {
		for (const length of [0, 1, 2, 15, 16, 17, 63, 64, 65, 127, 128, 129]) {
			for (const reverse of [false, true]) {
				for (const copy of [false, true]) {
					const input = new Type(
						Array.from(
							{ length },
							(_, i) => [0, -0, Infinity, -Infinity, 3, -3, 1.5][(i * 5) % 7],
						),
					);
					const output = sortFinite(input, reverse, copy);
					console.log(
						Type.name,
						length,
						reverse,
						copy,
						output === input,
						show(output),
						show(input),
					);
				}
			}
		}
	}
	console.log(
		"nan-result",
		show(new Float64Array([3, -0, 2, 0, 1]).sort((a, b) => (a - a) / (b - b))),
	);
}
