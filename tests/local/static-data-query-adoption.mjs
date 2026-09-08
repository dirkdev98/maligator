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
