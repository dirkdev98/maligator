function callEarly() {
	return late();
}
try {
	callEarly();
} catch (error) {
	console.log("before assignment", error instanceof TypeError);
}
var late = () => "after assignment";
console.log(callEarly());

var createShim =
	(name, getImplementation) =>
	(object, ...rest) => {
		const implementation = getImplementation.call(object) ?? object[name];
		return implementation.apply(object, rest);
	};
function relativeAt(index) {
	return this[index < 0 ? this.length + index : index];
}
var at = createShim("at", function () {
	if (Array.isArray(this)) return relativeAt;
});
var trimmed = createShim("trim", function () {
	if (typeof this === "string") return String.prototype.trim;
});
const values = [1, 2, 3];
let sum = 0;
for (let round = 0; round < 1000; round++) sum += at(values, -1 - (round % 3));
console.log(sum, at("abc", 1), at(values, 0), trimmed(" padded "));
try {
	trimmed([1]);
} catch (error) {
	console.log("no trim on arrays", error instanceof TypeError);
}

function describeThis(prefix) {
	return `${prefix}:${typeof this}:${this}`;
}
function invoke(target) {
	return target.call(5, "this");
}
console.log(invoke(describeThis));
try {
	invoke({ call: Function.prototype.call });
} catch (error) {
	console.log(error instanceof TypeError);
}

function withOwnCall() {
	return "original";
}
withOwnCall.call = function (receiver) {
	return `own call with ${receiver}`;
};
console.log(withOwnCall.call(7));

function thrower() {
	throw new RangeError(`thrown for ${this}`);
}
try {
	thrower.call("receiver");
} catch (error) {
	console.log(error instanceof RangeError, error.message);
}
