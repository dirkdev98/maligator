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

function calculate(prefix, value) {
	return prefix + value + this.offset;
}
function Point(x, y) {
	if (new.target === undefined) return `called with ${this.label}, ${x}, ${y}`;
	this.x = x;
	this.y = y;
}
function withOwnBind(value) {
	return `original ${value}`;
}
withOwnBind.bind =
	(_receiver, ...leading) =>
	(value) =>
		`own bind ${leading.length} ${value}`;
function withReplacedPrototype(value) {
	return `original ${value}`;
}
Object.setPrototypeOf(withReplacedPrototype, {
	bind: () => (value) => `prototype bind ${value}`,
});
function adder(left, right) {
	return this.base + left + right;
}
class Shape {
	constructor(sides) {
		this.sides = sides;
	}
}
const escaped = [];

function boundCalls(base) {
	const calculator = { offset: 11, calculate };
	const boundCalculate = calculator.calculate.bind(calculator, 5);
	let boundSum = 0;
	for (let round = 0; round < 1000; round++) boundSum += boundCalculate(round);
	console.log(boundSum, boundCalculate.name, boundCalculate.length);

	const BoundPoint = Point.bind({ label: "bound this" }, 1);
	console.log(BoundPoint(2));
	const point = new BoundPoint(2);
	console.log(point.x, point.y, point instanceof Point, point instanceof BoundPoint);

	const ownBound = withOwnBind.bind(null, 1);
	console.log(ownBound(2));
	const replacedBound = withReplacedPrototype.bind(null);
	console.log(replacedBound(3));

	const boundAdder = adder.bind({ base }, 1);
	escaped.push(boundAdder);
	console.log(boundAdder(2));

	const order = [];
	const argument = (label) => {
		order.push(label);
		return label;
	};
	const boundThrower = thrower.bind("bound receiver");
	try {
		boundThrower(argument("argument"));
	} catch (error) {
		order.push(error.message);
	}
	console.log(order.join(", "));

	const unbound = describeThis.bind();
	console.log(unbound("unbound"));

	const BoundShape = Shape.bind(null, 3);
	try {
		BoundShape();
	} catch (error) {
		console.log("class needs new", error instanceof TypeError);
	}
	console.log(new BoundShape().sides);
}
boundCalls(10);
boundCalls(20);
console.log(
	escaped.map((bound) => bound(3)).join(" "),
	escaped[0].name,
	escaped[0].length,
	escaped[0] === escaped[1],
);

function countArguments() {
	return `${arguments.length}:${[...arguments].join("|")}`;
}
function withOwnApply(value) {
	return `original ${value}`;
}
withOwnApply.apply = (receiver, list) => `own apply ${receiver} ${list.length}`;
function withReplacedApply(value) {
	return `original ${value}`;
}
Object.setPrototypeOf(withReplacedApply, {
	apply: (receiver, list) => `prototype apply ${list.join("+")}`,
});
function applyWithOrder(target, order) {
	const argument = (label) => {
		order.push(label);
		return label;
	};
	try {
		return target.apply(argument("receiver"), [argument("first"), argument("second")]);
	} catch (error) {
		order.push(`${error.constructor.name} ${error instanceof TypeError}`);
	}
}
const retained = [];

function appliedCalls(base) {
	const calculator = { offset: 13, calculate };
	let appliedSum = 0;
	for (let round = 0; round < 1000; round++)
		appliedSum += calculate.apply(calculator, [base, round]);
	console.log(appliedSum);

	console.log(
		countArguments.apply(null, [1, "two", base]),
		countArguments.apply(null, []),
	);
	console.log(countArguments.apply(null, [1, , 3]));
	console.log(describeThis.apply(undefined, ["applied"]));
	console.log(withOwnApply.apply(4, [5, 6]), withReplacedApply.apply(null, [7, 8]));

	const order = [];
	console.log(applyWithOrder(countArguments, order));
	applyWithOrder({ apply: Function.prototype.apply }, order);
	console.log(order.join(", "));
	const maybeCallable = base > 1 ? { apply: Function.prototype.apply } : countArguments;
	const applyOrder = [];
	const step = (label) => {
		applyOrder.push(label);
		return label;
	};
	try {
		applyOrder.push(
			maybeCallable.apply(step("receiver"), [step("first"), step("second")]),
		);
	} catch (error) {
		applyOrder.push(`${error.constructor.name} ${error instanceof TypeError}`);
	}
	console.log(applyOrder.join(", "));

	const reused = [base, 1];
	const first = countArguments.apply(null, reused);
	reused.push(2);
	console.log(first, countArguments.apply(null, reused));
	const kept = [base, 2];
	retained.push(kept);
	console.log(countArguments.apply(null, kept));

	try {
		thrower.apply("applied receiver", [base]);
	} catch (error) {
		console.log(error instanceof RangeError, error.message);
	}
	try {
		Shape.apply(null, [4]);
	} catch (error) {
		console.log("class needs new", error instanceof TypeError);
	}
}
appliedCalls(1);
appliedCalls(2);
retained[0].push("later");
console.log(
	retained.map((list) => list.join("|")).join(" "),
	retained[0] === retained[1],
);
