function query(needle, from, key) {
	return (
		["relocated", 5n].includes(needle, from) && { relocatedKey: 1 }.hasOwnProperty(key)
	);
}
globalThis.relocatedQuery = query;
let coercions = 0;
console.log(
	query(
		"relocated",
		{
			valueOf() {
				coercions++;
				return Function("return 0;")();
			},
		},
		{
			toString() {
				coercions++;
				if (typeof globalThis.__mal_collect_garbage === "function")
					globalThis.__mal_collect_garbage();
				return "relocatedKey";
			},
		},
	),
	coercions,
);
console.log(query(5n, 0, "relocatedKey"));

function indexQuery(needle, from) {
	return ["relocated", 5n, , undefined, "relocated"].indexOf(needle, from);
}
function lastIndexQuery(needle, from) {
	return ["relocated", 5n, , undefined, "relocated"].lastIndexOf(needle, from);
}
globalThis.relocatedIndexQuery = indexQuery;
globalThis.relocatedLastIndexQuery = lastIndexQuery;
for (const search of [indexQuery, lastIndexQuery]) {
	console.log(
		search("relocated", {
			valueOf() {
				coercions++;
				const index = Function("return 4;")();
				if (typeof globalThis.__mal_collect_garbage === "function")
					globalThis.__mal_collect_garbage();
				return index;
			},
		}),
		coercions,
	);
	console.log(search(undefined, 4), search(5n, 1));
}
