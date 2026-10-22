// Array iteration calls outside loops expand inline even when their callback
// branches, returns early, throws or writes bindings of the calling function.
const results = [];
const attempt = (label, run) => {
	try {
		results.push([label, run()]);
	} catch (error) {
		results.push([label, error.constructor.name, error.message]);
	}
};
const values = Array.from({ length: 64 }, (_, index) => (index * 37) % 101);

function sum(items) {
	let total = 0;
	items.forEach((value) => {
		total += value;
	});
	return total;
}
results.push(["sum", sum(values), sum([]), sum([1.5, "2", 3])]);

function countBelow(items, limit) {
	let below = 0;
	let above = 0;
	items.forEach((value) => {
		if (value < limit) below++;
		else if (value > limit) above++;
	});
	return [below, above];
}
results.push(["count", countBelow(values, 50), countBelow(values, -1)]);

function largest(items) {
	let best = -Infinity;
	let at = -1;
	items.forEach((value, index) => {
		if (value <= best) return;
		best = value;
		at = index;
	});
	return [best, at];
}
results.push(["largest", largest(values), largest([])]);

function stopsAtThrow(items) {
	let seen = 0;
	try {
		items.forEach((value) => {
			seen++;
			if (value > 90) throw new RangeError(`too large ${value}`);
		});
	} catch (error) {
		return [seen, error.message];
	}
	return [seen, "none"];
}
results.push(["throw", stopsAtThrow(values), stopsAtThrow([1, 2, 3])]);
attempt("uncaught", () => {
	let seen = 0;
	values.forEach((value) => {
		seen++;
		if (seen === 5) throw new TypeError(`stop at ${value}`);
	});
	return seen;
});

function closures(items) {
	const readers = [];
	let last;
	items.forEach((value, index) => {
		last = value;
		if (index < 3) readers.push(() => value + last);
	});
	return readers.map((read) => read());
}
results.push(["closures", closures(values)]);

function mutating(items) {
	const copy = items.slice(0, 8);
	const visited = [];
	copy.forEach((value, index, array) => {
		visited.push(value);
		if (index === 1) array.pop();
		if (index === 2) delete array[4];
		if (index === 3) array.push(-1);
	});
	return visited;
}
results.push(["mutating", mutating(values)]);

function holes() {
	const sparse = [1, , 3, , 5];
	let visits = 0;
	let product = 1;
	sparse.forEach((value) => {
		visits++;
		product *= value;
	});
	return [visits, product];
}
results.push(["holes", holes()]);

function nested(rows) {
	let cells = 0;
	let diagonal = 0;
	rows.forEach((row, r) => {
		row.forEach((cell, c) => {
			cells++;
			if (r === c) diagonal += cell;
		});
	});
	return [cells, diagonal];
}
results.push([
	"nested",
	nested([
		[1, 2, 3],
		[4, 5, 6],
		[7, 8, 9],
	]),
]);

function receiver(items) {
	const state = { hits: 0 };
	let sloppyThis;
	items.forEach(function (value) {
		if (value % 2 === 0) this.hits++;
		sloppyThis = typeof this;
	}, state);
	return [state.hits, sloppyThis];
}
results.push(["receiver", receiver(values)]);

function found(items, target) {
	let probes = 0;
	const index = items.findIndex((value) => {
		probes++;
		return value === target;
	});
	const exists = items.some((value) => {
		if (value !== target) return false;
		probes += 100;
		return true;
	});
	return [index, exists, probes];
}
results.push(["found", found(values, 74), found(values, 1000)]);

function mapped(items) {
	let odd = 0;
	const doubled = items.map((value) => {
		if (value % 2) {
			odd++;
			return value * 2;
		}
		return -value;
	});
	const kept = items.filter((value) => {
		if (value > 80) return true;
		odd -= 0.5;
		return false;
	});
	const total = items.reduce((sum, value) => {
		if (value > 50) return sum + value;
		return sum;
	}, 0);
	return [odd, doubled.slice(0, 6), kept, total];
}
results.push(["mapped", mapped(values)]);

const subclass = new (class extends Array {})(1, 2, 3);
results.push(["subclass", sum(subclass), countBelow(subclass, 2)]);

const shadowed = [1, 2, 3];
shadowed.forEach = function (callback) {
	callback(100);
};
results.push(["shadowed", sum(shadowed)]);

console.log(JSON.stringify(results));
