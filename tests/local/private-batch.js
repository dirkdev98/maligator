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

function makeReader() {
	return class extends StampBase {
		#value = undefined;

		static read(receiver) {
			return receiver.#value;
		}

		static write(receiver, value) {
			receiver.#value = value;
		}
	};
}

const Reader = makeReader();
const OtherReader = makeReader();
const crowded = {};
const crowdedKeys = Array.from({ length: 96 }, (_, i) => Symbol("before" + i));
for (const key of crowdedKeys) crowded[key] = "public";
new Reader(crowded);
Reader.write(crowded, "crowded");
const sparse = new Reader({});
Reader.write(sparse, "sparse");
const otherBrand = new OtherReader({});
OtherReader.write(otherBrand, "other brand");

for (let iteration = 0; iteration < 20; iteration++) {
	ok(
		Reader.read(crowded) === "crowded",
		"private read among preceding symbol properties",
	);
	ok(Reader.read(sparse) === "sparse", "same private name on a shorter receiver");
	let threw = false;
	try {
		Reader.read(otherBrand);
	} catch (error) {
		threw = error instanceof TypeError;
	}
	ok(threw, "same field position with another class brand rejects the receiver");
}

for (const key of crowdedKeys) delete crowded[key];
for (let index = 0; index < 256; index++) crowded[Symbol("after" + index)] = index;
ok(
	Reader.read(crowded) === "crowded",
	"private read survives public symbol deletion and growth",
);

const uninitialized = new Reader({});
ok(Reader.read(uninitialized) === undefined, "undefined private value is present");
const objectValue = { identity: "private" };
Reader.write(uninitialized, objectValue);
Object.freeze(uninitialized);
ok(Reader.read(uninitialized) === objectValue, "private read on a frozen receiver");
Reader.write(uninitialized, "after freeze");
ok(
	Reader.read(uninitialized) === "after freeze",
	"private read observes writes after freezing",
);

let proxyTraps = 0;
const proxy = new Proxy(
	{},
	{
		get() {
			proxyTraps++;
			throw new Error("private read invoked get trap");
		},
		getOwnPropertyDescriptor() {
			proxyTraps++;
			throw new Error("private read invoked descriptor trap");
		},
	},
);
new Reader(proxy);
Reader.write(proxy, "proxy field");
ok(Reader.read(proxy) === "proxy field", "private field belongs to the stamped proxy");
ok(proxyTraps === 0, "private reads bypass proxy traps");

for (const absent of [{}, Object.create(sparse), new Proxy(sparse, {}), null, 7]) {
	let threw = false;
	try {
		Reader.read(absent);
	} catch (error) {
		threw = error instanceof TypeError;
	}
	ok(threw, "private reads reject absent own brands and primitive receivers");
}

class StaticReader {
	static #value = "static";

	static read(receiver) {
		return receiver.#value;
	}
}
class StaticChild extends StaticReader {}
ok(
	StaticReader.read(StaticReader) === "static",
	"private static field reads its declaring class",
);
let inheritedStaticThrew = false;
try {
	StaticReader.read(StaticChild);
} catch (error) {
	inheritedStaticThrew = error instanceof TypeError;
}
ok(inheritedStaticThrew, "private static fields are not inherited");

console.log("private-batch PASS");
