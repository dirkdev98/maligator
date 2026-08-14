const iteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const originalNext = iteratorPrototype.next;
let nextCalls = 0;
iteratorPrototype.next = function patchedNext() {
	nextCalls++;
	return originalNext.call(this);
};

function control() {
	function classify(values) {
		let sum = 0;
		let errors = 0;
		for (const value of values) {
			try {
				if (value % 7 === 0) throw "div7";
				sum = sum + (value % 100);
			} catch (error) {
				errors = errors + 1;
			}
		}
		return sum + errors * 1000;
	}
	const data = [];
	for (let index = 0; index < 3; index++) data.push(index * 31 + 1);
	let result = 0;
	for (let round = 0; round < 4; round++) result = result + classify(data);
	return result;
}

if (control() !== 4132 || nextCalls !== 16) {
	throw new Error(`patched iterator next was elided: calls=${nextCalls}`);
}

iteratorPrototype.next = originalNext;
console.log("private-aggregate-memo-guards PASS 1/1");
