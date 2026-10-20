// Comparators that capture scopes reach a search helper through its parameter.
// The bundle-style wrapper runs once, so its helpers may be inlined into the
// search clones; the factory runs twice, so each comparator keeps its own scope.
((exports) => {
	function compareOrdered(a, b) {
		let order = 0;
		while (order === 0 && a !== b) order = a === undefined || a < b ? -1 : 1;
		return order;
	}
	function compareValues(a, b) {
		return compareOrdered(a, b);
	}
	function find(values, value, select, compare) {
		return search(values, select(value), select, compare);
	}
	let searches = 0;
	function search(values, key, select, compare) {
		searches++;
		let low = 0;
		let high = values.length - 1;
		while (low <= high) {
			const middle = low + ((high - low) >> 1);
			const order = compare(select(values[middle]), key);
			if (order === 0) return middle;
			if (order < 0) low = middle + 1;
			else high = middle - 1;
		}
		return ~low;
	}
	function makeShifted(shift) {
		return function compareShifted(a, b) {
			return compareOrdered(a + shift, b);
		};
	}
	function createIndex(entries) {
		const byId = (entry) => entry.id;
		const shiftedBy3 = makeShifted(3);
		const shiftedBy30 = makeShifted(30);
		return {
			has: (entry) => find(entries, entry, byId, compareValues) >= 0,
			shifted: (entry) =>
				find(entries, entry, byId, shiftedBy3) + find(entries, entry, byId, shiftedBy30),
		};
	}
	exports.createIndex = createIndex;
	exports.searches = () => searches;
})(module.exports);

const index = module.exports.createIndex(
	Array.from({ length: 40 }, (_, position) => ({ id: position * 3 })),
);
let found = 0;
let shifted = 0;
for (let id = 0; id < 200; id++) {
	if (index.has({ id })) found++;
	shifted += index.shifted({ id });
}
console.log([found, shifted, module.exports.searches()].join(","));
