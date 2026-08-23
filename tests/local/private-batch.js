function ok(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
}

function makeClass() {
	return class {
		#a;
		#b;
		#initialized = [this.#a, this.#b];
		#c;
		#d;

		#method() {
			return this.#initialized;
		}

		get #accessor() {
			return this.#method();
		}

		values() {
			return [this.#a, this.#b, this.#accessor, this.#c, this.#d];
		}

		static has(value) {
			return #a in value;
		}
	};
}

const First = makeClass();
const Second = makeClass();
const first = new First();
const values = first.values();
ok(
	values.length === 5 &&
		values[0] === undefined &&
		values[1] === undefined &&
		Array.isArray(values[2]) &&
		values[3] === undefined &&
		values[4] === undefined,
	"fields initialize",
);
ok(
	values[2][0] === undefined && values[2][1] === undefined,
	"initialized boundary observes prior fields",
);
ok(First.has(first), "own evaluation brand");
ok(!Second.has(first), "fresh private identity per class evaluation");
ok(!First.has({}), "absent private brand stays false when unboxed");

let effects = 0;
class StampBase {
	constructor(receiver) {
		return receiver;
	}
}
class Stamper extends StampBase {
	#a;
	#b;
	marker = effects++;
}
const receiver = {};
new Stamper(receiver);
let duplicateThrew = false;
try {
	new Stamper(receiver);
} catch (error) {
	duplicateThrew = error instanceof TypeError;
}
ok(duplicateThrew, "duplicate stamping throws");
ok(effects === 1, "abrupt private initialization stops later fields");

let brandEffects = 0;
class BrandedStamper extends StampBase {
	#method() {}
	#field = brandEffects++;
}
const brandedReceiver = {};
new BrandedStamper(brandedReceiver);
try {
	new BrandedStamper(brandedReceiver);
} catch {}
ok(brandEffects === 1, "method brand installs before fields");

class PrivateTargets {
	#field;

	set #setter(value) {
		this.setterValue = value;
		return "ignored";
	}

	target(log) {
		log.push("receiver");
		return this;
	}

	write(source, log) {
		const result = ({ value: this.target(log).#field } = source);
		const setterResult = (this.#setter = 7);
		return [result, setterResult, this.#field];
	}

	forOf(source) {
		for (this.#field of source) break;
	}

	forIn(source) {
		for (this.#field in source) break;
	}

	array(source) {
		[this.#field] = source;
	}

	arrayRest(source) {
		[...this.#field] = source;
	}

	object(source) {
		({ value: this.#field } = source);
	}

	objectRest(source) {
		({ ...this.#field } = source);
	}
}

const target = new PrivateTargets();
const assignmentLog = [];
const assignmentSource = {
	get value() {
		assignmentLog.push("get");
		return 42;
	},
};
const assignmentValues = target.write(assignmentSource, assignmentLog);
ok(assignmentLog.join(",") === "receiver,get", "private target precedes source getter");
ok(assignmentValues[0] === assignmentSource, "destructuring returns its source");
ok(assignmentValues[1] === 7, "private setter assignment returns its RHS");
ok(assignmentValues[2] === 42 && target.setterValue === 7, "private stores values");

for (const [method, source] of [
	["forOf", [1]],
	["forIn", { value: 1 }],
	["array", [1]],
	["arrayRest", [1]],
	["object", { value: 1 }],
	["objectRest", { value: 1 }],
]) {
	let threw = false;
	try {
		PrivateTargets.prototype[method].call({}, source);
	} catch (error) {
		threw = error instanceof TypeError;
	}
	ok(threw, method + " checks the private receiver");
}

const getterError = new Error("getter wins");
try {
	PrivateTargets.prototype.object.call(
		{},
		{
			get value() {
				throw getterError;
			},
		},
	);
	ok(false, "source getter should throw");
} catch (error) {
	ok(error === getterError, "private brand check follows source getter");
}

class LateStamp extends StampBase {
	#field;

	write(source) {
		({ value: this.#field } = source);
		return this.#field;
	}
}
const lateReceiver = {};
const lateSource = {
	get value() {
		new LateStamp(lateReceiver);
		return "late";
	},
};
ok(
	LateStamp.prototype.write.call(lateReceiver, lateSource) === "late",
	"source getter may install the brand before PutValue",
);

console.log("private-batch PASS");
