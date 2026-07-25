"use strict";

function assert(value, message) {
	if (!value) throw new Error(message);
}

const counters = { parentCalls: 0, fieldRuns: 0 };

class Base {
	constructor() {
		counters.parentCalls++;
		this.order = ["base"];
	}
}

class EvalDerived extends Base {
	#private = (counters.fieldRuns++, this.order.push("private"), 41);
	public = (counters.fieldRuns++, this.order.push("public"), this.#private + 1);

	constructor() {
		eval("super()");
		assert(this.#private === 41 && this.public === 42, "eval initialized fields");
		assert(this.order.join(",") === "base,private,public", "eval field order");
	}
}

class EvalSub extends EvalDerived {}
const evalValue = new EvalSub();
assert(evalValue instanceof EvalSub, "eval preserved new.target");

class ArrowDerived extends Base {
	#private = (counters.fieldRuns++, 7);
	public = (counters.fieldRuns++, this.#private + 1);

	constructor() {
		(() => super())();
		assert(this.#private === 7 && this.public === 8, "arrow initialized fields");
		this.repeat = () => super();
	}
}

const arrowValue = new ArrowDerived();
let repeatedThrew = false;
let repeatedMessage = "";
try {
	arrowValue.repeat();
} catch (error) {
	repeatedThrew = error instanceof ReferenceError;
	repeatedMessage = error.message;
}

assert(repeatedThrew, "repeated escaped super throws ReferenceError");
assert(
	counters.parentCalls === 3,
	"repeated super constructs parent before BindThisValue: " +
		counters.parentCalls +
		" " +
		repeatedMessage,
);
assert(counters.fieldRuns === 4, "instance fields initialize exactly once");

console.log("eval-super PASS 1/1");
