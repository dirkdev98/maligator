let failed = false;
const gc = globalThis.__mal_collect_garbage;

function check(condition, message) {
	if (!condition) {
		failed = true;
		console.log("FAIL: " + message);
	}
}

function collect() {
	const garbage = [];
	for (let i = 0; i < 64; i++) garbage.push({ value: "garbage-" + i });
	if (typeof gc === "function") gc();
}

const deletedValueKey = "deleted-value-" + "x".repeat(128);
const valuesSource = {};
Object.defineProperty(valuesSource, "first", {
	enumerable: true,
	get() {
		delete valuesSource[deletedValueKey];
		collect();
		return 1;
	},
});
valuesSource[deletedValueKey] = 2;
valuesSource.last = 3;
check(
	Object.values(valuesSource).join(",") === "1,3",
	"Object.values rooted key deletion",
);

const deletedJsonKey = "deleted-json-" + "y".repeat(128);
const jsonSource = {};
Object.defineProperty(jsonSource, "first", {
	enumerable: true,
	get() {
		delete jsonSource[deletedJsonKey];
		collect();
		return 1;
	},
});
jsonSource[deletedJsonKey] = 2;
jsonSource.last = 3;
check(
	JSON.stringify(jsonSource) === '{"first":1,"last":3}',
	"JSON.stringify rooted key deletion",
);

const reviverVisits = [];
JSON.parse('{"first":1,"deleted":2,"last":3}', function (key, value) {
	if (key === "first") {
		delete this.deleted;
		collect();
	}
	if (key !== "") reviverVisits.push(key + ":" + String(value));
	return value;
});
check(
	reviverVisits.join(",") === "first:1,deleted:undefined,last:3",
	"JSON.parse reviver retains snapshotted keys",
);

const proxyDeletedKey = "proxy-deleted-" + "z".repeat(128);
const proxyTarget = { first: 1, [proxyDeletedKey]: 2, last: 3 };
const proxy = new Proxy(proxyTarget, {
	ownKeys(target) {
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		if (key === "first") {
			delete target[proxyDeletedKey];
			collect();
		}
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
});
check(
	Object.values(proxy).join(",") === "1,3",
	"proxy descriptor policy remains caller-owned",
);

const visibilitySource = {};
Object.defineProperty(visibilitySource, "first", {
	enumerable: true,
	get() {
		Object.defineProperty(visibilitySource, "later", { enumerable: true });
		return 1;
	},
});
Object.defineProperty(visibilitySource, "later", {
	value: 2,
	writable: true,
	configurable: true,
	enumerable: false,
});
check(
	Object.values(visibilitySource).join(",") === "1,2",
	"Object.values snapshots non-enumerable keys before getters",
);

Object.defineProperty(visibilitySource, "later", { enumerable: false });
check(
	Object.entries(visibilitySource)
		.map((entry) => entry.join(":"))
		.join(",") === "first:1,later:2",
	"Object.entries rechecks snapshotted key enumerability",
);

Object.defineProperty(visibilitySource, "later", { enumerable: false });
check(
	JSON.stringify(visibilitySource) === '{"first":1}',
	"JSON.stringify snapshots enumerable keys before getters",
);

const jsonLog = [];
const jsonSymbol = Symbol("ignored");
const jsonProxy = new Proxy(
	{ a: 1, b: 2, hidden: 3, [jsonSymbol]: 4 },
	{
		ownKeys() {
			jsonLog.push("ownKeys");
			return ["b", jsonSymbol, "hidden", "a"];
		},
		getOwnPropertyDescriptor(target, key) {
			jsonLog.push("desc:" + String(key));
			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
			if (key === "hidden") descriptor.enumerable = false;
			return descriptor;
		},
		get(target, key, receiverValue) {
			jsonLog.push("get:" + String(key));
			return Reflect.get(target, key, receiverValue);
		},
	},
);
check(
	JSON.stringify(jsonProxy) === '{"b":2,"a":1}' &&
		jsonLog.join(",") === "get:toJSON,ownKeys,desc:b,desc:hidden,desc:a,get:b,get:a",
	"JSON.stringify uses proxy ownKeys, descriptors, and string-key order",
);

const stagedTarget = {};
let stagedGetterCount = 0;
const stagedDescriptors = {
	get good() {
		return {
			get value() {
				stagedGetterCount++;
				return 1;
			},
			enumerable: true,
		};
	},
	bad: { get: 1 },
};
let stagedThrew = false;
try {
	Object.defineProperties(stagedTarget, stagedDescriptors);
} catch (error) {
	stagedThrew = error instanceof TypeError;
}
check(
	stagedThrew && stagedGetterCount === 1 && !("good" in stagedTarget),
	"Object.defineProperties validates all descriptors before definitions",
);

const descriptorProxyLog = [];
let descriptorValueReads = 0;
const descriptorSourceTarget = {
	x: {
		get value() {
			descriptorValueReads++;
			return 7;
		},
		enumerable: true,
	},
};
const descriptorSource = new Proxy(descriptorSourceTarget, {
	ownKeys(target) {
		descriptorProxyLog.push("ownKeys");
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		descriptorProxyLog.push("desc:" + String(key));
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
	get(target, key, receiverValue) {
		descriptorProxyLog.push("get:" + String(key));
		return Reflect.get(target, key, receiverValue);
	},
});
const defineProxyLog = [];
const defineProxyTarget = new Proxy(
	{},
	{
		defineProperty(target, key, descriptor) {
			defineProxyLog.push(
				String(key) + ":" + descriptor.value + ":" + descriptor.enumerable,
			);
			return Reflect.defineProperty(target, key, descriptor);
		},
	},
);
Object.defineProperties(defineProxyTarget, descriptorSource);
check(
	descriptorProxyLog.join(",") === "ownKeys,desc:x,get:x" &&
		descriptorValueReads === 1 &&
		defineProxyLog.join(",") === "x:7:true" &&
		defineProxyTarget.x === 7,
	"Object.defineProperties stages proxy sources and defines proxy targets",
);

let createDescriptorReads = 0;
let createThrew = false;
try {
	Object.create(null, {
		get first() {
			createDescriptorReads++;
			return { value: 1 };
		},
		get invalid() {
			createDescriptorReads++;
			return { set: 1 };
		},
	});
} catch (error) {
	createThrew = error instanceof TypeError;
}
check(
	createThrew && createDescriptorReads === 2,
	"Object.create stages and validates descriptors",
);

const assignSymbol = Symbol("assign");
const assignOrder = [];
const assignSource = {};
Object.defineProperty(assignSource, "2", {
	enumerable: true,
	get() {
		assignOrder.push("2");
		Object.defineProperty(assignSource, "later", { enumerable: true });
		Object.defineProperty(assignSource, "skip", { enumerable: false });
		assignSource.added = 9;
		return 2;
	},
});
Object.defineProperty(assignSource, "1", {
	enumerable: true,
	get() {
		assignOrder.push("1");
		return 1;
	},
});
Object.defineProperty(assignSource, "later", {
	value: 3,
	writable: true,
	configurable: true,
	enumerable: false,
});
Object.defineProperty(assignSource, "skip", {
	value: 4,
	configurable: true,
	enumerable: true,
});
Object.defineProperty(assignSource, "text", {
	enumerable: true,
	get() {
		assignOrder.push("text");
		return 5;
	},
});
Object.defineProperty(assignSource, assignSymbol, {
	enumerable: true,
	get() {
		assignOrder.push("symbol");
		return 6;
	},
});
const assigned = Object.assign({}, assignSource);
check(
	assignOrder.join(",") === "1,2,text,symbol" &&
		Object.keys(assigned).join(",") === "1,2,later,text" &&
		assigned[assignSymbol] === 6 &&
		!("skip" in assigned) &&
		!("added" in assigned),
	"Object.assign snapshots all keys and rechecks descriptors in key order",
);

const assignProxyLog = [];
const assignProxy = new Proxy(
	{ a: 1, b: 2 },
	{
		ownKeys() {
			assignProxyLog.push("ownKeys");
			return ["b", "a"];
		},
		getOwnPropertyDescriptor(target, key) {
			assignProxyLog.push("desc:" + key);
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
		get(target, key, receiverValue) {
			assignProxyLog.push("get:" + key);
			return Reflect.get(target, key, receiverValue);
		},
	},
);
check(
	Object.keys(Object.assign({}, assignProxy)).join(",") === "b,a" &&
		assignProxyLog.join(",") === "ownKeys,desc:b,get:b,desc:a,get:a",
	"Object.assign preserves proxy key and trap order",
);

const boundaryKeys = {};
boundaryKeys["2147483648"] = "string-limit";
boundaryKeys.alpha = 1;
boundaryKeys["2147483647"] = "index-limit";
check(
	Object.keys(boundaryKeys).join(",") === "2147483647,2147483648,alpha" &&
		boundaryKeys[2147483647] === "index-limit" &&
		boundaryKeys[2147483648] === "string-limit",
	"INT32_MAX is the property-index boundary",
);

const receiver = {
	toString() {
		collect();
		return "receiver-" + "r".repeat(64);
	},
};
const concat = String.prototype.concat.call(
	receiver,
	{
		toString() {
			collect();
			return "-middle-" + "m".repeat(64);
		},
	},
	{
		toString() {
			collect();
			return "-tail";
		},
	},
);
check(
	concat === "receiver-" + "r".repeat(64) + "-middle-" + "m".repeat(64) + "-tail",
	"String.concat roots progressively grown parts",
);

const joinParts = [];
for (let i = 0; i < 20; i++) {
	joinParts.push({
		toString() {
			collect();
			return String(i);
		},
	});
}
const separator = {
	toString() {
		collect();
		return "::";
	},
};
check(
	joinParts.join(separator) ===
		Array.from({ length: 20 }, (_, i) => String(i)).join("::"),
	"Array.join roots separator and grown parts",
);

const localeParts = Array.from({ length: 20 }, (_, i) => ({
	toLocaleString() {
		collect();
		return "L" + i;
	},
}));
check(
	localeParts.toLocaleString() ===
		Array.from({ length: 20 }, (_, i) => "L" + i).join(","),
	"Array.toLocaleString roots grown results",
);

console.log(failed ? "rooted-collections FAIL" : "rooted-collections PASS");
