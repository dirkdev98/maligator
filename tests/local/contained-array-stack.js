function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function drain(count) {
	const stack = [];
	let expected = 0;
	for (let index = 0; index < count; index++) {
		const entry = { index, label: `item-${index}` };
		stack.push(entry);
		expected += index;
	}
	let actual = 0;
	while (stack.length > 0) {
		const entry = stack.pop();
		actual += entry.index;
		assert(entry.label === `item-${entry.index}`, "object value survived");
	}
	assert(stack.pop() === undefined, "empty pop");
	return actual === expected;
}

function multipleAndExtraArguments() {
	const stack = [];
	let effects = 0;
	assert(stack.push(1, 2, 3) === 3, "push result");
	assert(stack.pop((effects += 1)) === 3, "pop ignores evaluated arguments");
	assert(effects === 1, "extra argument evaluated");
	return stack.pop() === 2 && stack.pop() === 1 && stack.length === 0;
}

function initiallyDenseFrames() {
	const stack = [{ value: 1, next: 0 }];
	let total = 0;
	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		total += frame.value;
		if (frame.next++ === 0 && frame.value < 50) {
			stack.push({ value: frame.value + 1, next: 0 });
		} else {
			stack.pop();
		}
	}
	return total === 2500;
}

function holesStaySemantic() {
	const values = [, 2];
	assert(values.pop() === 2, "hole array value");
	assert(values.pop() === undefined, "hole array hole");
	assert(values.push(3) === 1 && values[0] === 3, "hole array reuse");
	return true;
}

function sparseWriteBeforePop() {
	const values = [];
	values[2] = 7;
	assert(values.pop() === 7, "sparse write value");
	assert(values.pop() === undefined, "sparse write hole");
	return values.length === 1;
}

function escapedAndShadowed() {
	const escaped = [];
	function append(array) {
		return array.push(4);
	}
	assert(append(escaped) === 1 && escaped.pop() === 4, "escaped fallback");

	const shadowed = [];
	shadowed.push = function (value) {
		return value + 10;
	};
	assert(shadowed.push(5) === 15 && shadowed.length === 0, "own shadow");

	const self = [];
	self.push(self);
	assert(self.pop() === self, "self escape");
	return true;
}

assert(drain(4000), "drain");
assert(multipleAndExtraArguments(), "multiple arguments");
assert(initiallyDenseFrames(), "initial dense frames");
assert(holesStaySemantic(), "holes");
assert(sparseWriteBeforePop(), "sparse write");
assert(escapedAndShadowed(), "conservative cases");
console.log("contained-array-stack PASS");
