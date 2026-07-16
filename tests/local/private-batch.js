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

console.log("private-batch PASS");
