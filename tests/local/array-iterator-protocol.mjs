function walk(source, observe) {
	let result = "";
	for (const value of source) {
		result += `/${value}`;
		if (observe !== undefined) observe(value);
	}
	return result;
}

const dense = [1, 2, 3];
console.log("dense", walk(dense));
console.log("holes", walk([1, , 3]));

const growing = [1, 2];
console.log(
	"growth",
	walk(growing, (value) => {
		if (value === 1) growing.push(3);
	}),
);
const shrinking = [1, 2, 3];
console.log(
	"shrink",
	walk(shrinking, (value) => {
		if (value === 1) shrinking.length = 1;
	}),
);

const holey = [1, , 3];
let inherited;
Object.defineProperty(Array.prototype, "1", {
	configurable: true,
	get() {
		holey[2] = 4;
		return 2;
	},
});
try {
	inherited = walk(holey);
} finally {
	delete Array.prototype[1];
}
console.log("inherited", inherited);

const own = [1, 2];
own[Symbol.iterator] = function* () {
	yield "own";
};
console.log("own iterator", walk(own));

class WrappedArray extends Array {
	*[Symbol.iterator]() {
		yield this[0] * 10;
	}
}
const subclass = new WrappedArray();
subclass.push(3);
console.log("Array subclass", walk(subclass));

const arrayIterator = Array.prototype[Symbol.iterator];
let prototypeResult;
Array.prototype[Symbol.iterator] = function* () {
	yield "prototype";
};
try {
	prototypeResult = walk([1, 2]);
} finally {
	Array.prototype[Symbol.iterator] = arrayIterator;
}
console.log("prototype iterator", prototypeResult);

const prototype = Object.getPrototypeOf(arrayIterator.call([]));
const next = prototype.next;
let steps = 0;
let nextResult;
prototype.next = function () {
	return { value: "patched", done: steps++ > 0 };
};
try {
	nextResult = walk([1, 2]);
} finally {
	prototype.next = next;
}
console.log("patched next", nextResult, steps);
