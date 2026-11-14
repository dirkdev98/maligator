// Replaces, redefines, deletes and restores global primordial bindings and their
// namespace methods through each writer, before warm loops and from inside one. The
// case named by PRIMORDIAL_BINDING_CASE runs alone, so every writer meets bindings
// nothing has touched yet; each loop must observe exactly the current values.
const environment = globalThis.process?.env ?? {};
const mode = environment.PRIMORDIAL_BINDING_CASE ?? "intact";
const rounds = 64;
const results = [];
function record(label, value) {
	results[results.length] = `${label}=${value}`;
}

const original = {
	Math: globalThis.Math,
	max: Math.max,
	Number: globalThis.Number,
	parseInt: globalThis.parseInt,
	parseFloat: globalThis.parseFloat,
	numberParseInt: Number.parseInt,
	JSON: globalThis.JSON,
	String: globalThis.String,
	keys: Object.keys,
	Map: globalThis.Map,
};

const fakeMath = Object.assign(Object.create(original.Math), {
	max: (left, right) => `max(${left},${right})`,
	trunc: (value) => `trunc(${value})`,
});
const fakeNumber = Object.assign((value) => `Number(${value})`, {
	parseInt: (text, radix) => `parseInt(${text},${radix})`,
	parseFloat: original.Number.parseFloat,
	isFinite: original.Number.isFinite,
});
const fakeJSON = { stringify: (value) => `json:${Object.keys(value)}` };
class FakeMap extends original.Map {
	get size() {
		return -1;
	}
}

function hash(digest, text) {
	let value = digest;
	for (let index = 0; index < text.length; index++)
		value = (Math.imul(value, 31) + text.charCodeAt(index)) | 0;
	return value;
}

// A run of Math calls on Numbers, which a guarded copy computes as numeric kernels.
function bounded(value) {
	const clamped = Math.min(1_000, Math.max(-1_000, value));
	return (
		Math.round(Math.sqrt(Math.abs(value)) * 100) +
		Math.trunc(clamped) +
		Math.floor(value / 7)
	);
}

function sample(value, text) {
	const object = { value, text };
	const parts = [
		bounded(value),
		Math.max(value, 1),
		Number.parseInt(text, 10),
		Math.trunc(Number.parseFloat(text)),
		Number.isFinite(Number(text)),
		parseInt(text, 16),
		parseFloat(text),
		Object.keys(object).length,
		JSON.stringify(object),
		Array.isArray(text),
		String(value),
		new Map().size,
	];
	return parts.join(",");
}

function warm(label, hook) {
	let digest = 0;
	let last = "";
	try {
		for (let round = 0; round < rounds; round++) {
			if (hook !== undefined) hook(round);
			last = sample(((round * 37) % 101) - 50.5, String(round * 3 + 1));
			digest = hash(digest, last);
		}
		record(label, `${digest}:${last}`);
	} catch (error) {
		record(label, `${error.constructor.name}`);
	}
}

const cases = {
	intact() {
		warm("second");
	},
	"same-value"() {
		globalThis.Math = original.Math;
		Object.defineProperty(globalThis, "Number", { enumerable: false });
		Reflect.set(globalThis, "JSON", original.JSON);
		warm("unchanged");
	},
	"assign-namespace"() {
		globalThis.Math = fakeMath;
		warm("replaced");
		globalThis.Math = original.Math;
		warm("restored");
	},
	"assign-method"() {
		Math.max = fakeMath.max;
		warm("replaced");
		Math.max = original.max;
		warm("restored");
	},
	"assign-function"() {
		Number = fakeNumber;
		warm("replaced");
		Number = original.Number;
		warm("restored");
	},
	"assign-construct"() {
		globalThis.Map = FakeMap;
		warm("replaced");
		globalThis.Map = original.Map;
		warm("restored");
	},
	"define-namespace"() {
		Object.defineProperty(globalThis, "Math", { value: fakeMath });
		warm("replaced");
		Object.defineProperty(globalThis, "Math", { value: original.Math });
		warm("restored");
	},
	"define-accessor"() {
		let reads = 0;
		Object.defineProperty(globalThis, "Number", {
			get() {
				reads++;
				return original.Number;
			},
			configurable: true,
		});
		warm("getter");
		record("reads", reads);
		Object.defineProperty(globalThis, "Number", {
			value: original.Number,
			writable: true,
			configurable: true,
		});
		warm("restored");
		record("reads", reads);
	},
	"delete-namespace"() {
		delete globalThis.Number;
		warm("deleted");
		globalThis.Number = original.Number;
		warm("restored");
	},
	"delete-method"() {
		delete Number.parseInt;
		warm("deleted");
		Number.parseInt = original.numberParseInt;
		warm("restored");
	},
	"reflect-set"() {
		Reflect.set(globalThis, "parseInt", (text, radix) => `reflected(${text},${radix})`);
		warm("replaced");
		Reflect.set(globalThis, "parseInt", original.parseInt);
		warm("restored");
	},
	"reflect-define"() {
		Reflect.defineProperty(globalThis, "String", { value: (value) => `S${value}` });
		warm("replaced");
		Reflect.defineProperty(globalThis, "String", { value: original.String });
		warm("restored");
	},
	"object-assign"() {
		Object.assign(globalThis, { parseFloat: (text) => `float(${text})`, JSON: fakeJSON });
		warm("replaced");
		Object.assign(globalThis, { parseFloat: original.parseFloat, JSON: original.JSON });
		warm("restored");
	},
	"object-keys"() {
		Object.keys = () => ["one", "two", "three"];
		warm("replaced");
		Object.keys = original.keys;
		warm("restored");
	},
	"mid-loop"() {
		warm("hooked", (round) => {
			if (round === 20) globalThis.Math = fakeMath;
			if (round === 40) globalThis.Math = original.Math;
			if (round === 50) Math.max = fakeMath.max;
		});
		Math.max = original.max;
		warm("restored");
	},
	"mid-loop-method"() {
		warm("hooked", (round) => {
			if (round === 30) Math.max = fakeMath.max;
		});
		Math.max = original.max;
		warm("restored");
	},
};

warm("first");
cases[mode]();
console.log(mode, results.join("\n"));
