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

let directSuperCaught;
class DirectSuperBase {}
class DirectSuperDerived extends DirectSuperBase {
	constructor() {
		try {
			super.x;
		} catch (error) {
			directSuperCaught = error;
		}
		super();
	}
}
new DirectSuperDerived();
assert(
	directSuperCaught instanceof ReferenceError,
	"direct super property read checks this inside try",
);

let readCapturedThis;
class CapturedThisBase {
	constructor() {
		let threw = false;
		try {
			readCapturedThis();
		} catch (error) {
			threw = error instanceof ReferenceError;
		}
		assert(threw, "captured this stays uninitialized while super runs");
	}
}
class CapturedThisDerived extends CapturedThisBase {
	constructor() {
		readCapturedThis = () => this;
		super();
		assert(readCapturedThis() === this, "captured this refreshes after super");
	}
}
new CapturedThisDerived();

console.log("eval-super PASS 1/1");
