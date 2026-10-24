"use strict";

// Each returned closure keeps only `middle`'s scope; `outer`'s scope, its lexical
// parent, dies while the closures keep running and allocating.
function outer(seed) {
	const table = Array.from({ length: 64 }, (_, i) => ({ i: i + seed }));
	function middle() {
		let count = table.length;
		return () => {
			const garbage = [];
			for (let i = 0; i < 200; i++) garbage.push({ i, s: "x" + i });
			count += garbage.length;
			return count;
		};
	}
	return middle();
}

const counters = [];
for (let i = 0; i < 50; i++) counters.push(outer(i));
let total = 0;
for (let round = 0; round < 20; round++) {
	for (const counter of counters) total += counter();
}
console.log(total === 2164000 ? "ENV OWNER PASS" : `ENV OWNER ${total}`);
