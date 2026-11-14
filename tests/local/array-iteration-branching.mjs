function inspect(values, mode) {
	const visits = [];
	let result = 0;
	let descending = false;
	let matched = false;
	let error;
	try {
		matched = values.some((element, index, array) => {
			if (typeof element === "function") element = element(index, array);
			else if (typeof element === "string") {
				descending = element.charAt(0) === "-";
				element = descending ? element.slice(1) : element;
			} else if (typeof element === "bigint") element = Number(element);
			else if (element === null) element = "null";
			else if (element === undefined) element = "undefined";
			else if (typeof element === "object") element = element.value;
			else if (element === true) element = 1;
			else if (element === false) element = 0;

			visits.push([index, element]);
			result = descending ? -Number(element) : Number(element);
			if (mode === "mutate" && index === 0) {
				delete array[2];
				array[1] = "-7";
				array.push("9");
			}
			if (mode === "throw" && index === 1) throw new RangeError("callback stopped");
			return mode === "match" && result === -7;
		});
	} catch (caught) {
		error = [caught.name, caught.message];
	}
	return { visits, result, descending, matched, error };
}

function copied(values) {
	let total = 0;
	[values].flat().some((value) => {
		total += value;
		return value > 2;
	});
	return total;
}

function copiedWithSpecies(values) {
	const source = [values];
	source.constructor = class extends Array {
		some(callback) {
			callback(this[1], 1, this);
			return false;
		}
	};
	let total = 0;
	source.flat().some((value) => {
		total += value;
		return value > 2;
	});
	return total;
}

function exposed(values, customize) {
	const result = [values].flat();
	customize(result);
	let total = 0;
	result.some((value) => {
		total += value;
		return value > 2;
	});
	return total;
}

console.log("copied", copied([2, 7, 9]));
console.log("species", copiedWithSpecies([2, 7, 9]));
console.log(
	"exposed",
	exposed([2, 7, 9], (array) => {
		array.some = (callback) => callback(11);
	}),
);
console.log("bindings", JSON.stringify(inspect(["-2", "3", 4n, { value: 5 }], "all")));
console.log(
	"branches",
	JSON.stringify(inspect([null, undefined, true, false, () => 8], "all")),
);
console.log("early", JSON.stringify(inspect(["2", "-7", "9"], "match")));
console.log("throw", JSON.stringify(inspect(["-2", "3", "9"], "throw")));
console.log("mutation", JSON.stringify(inspect(["2", "3", "4"], "mutate")));
console.log("holes", JSON.stringify(inspect([, "-2", , "3", ,], "all")));

function normalized(value, stop) {
	const visits = [];
	const matched = [value].flat().some((element, index) => {
		const retained = { element, index, padding: new Array(5).fill("root") };
		visits.push(retained.element, retained.index);
		return element === stop;
	});
	return [matched, visits];
}

class FlatInput extends Array {
	static get [Symbol.species]() {
		throw new Error("the inner array's species must stay unread");
	}
}
const proxyTrace = [];
const proxyArray = new Proxy(["first", , "stop", "last"], {
	has(target, key) {
		proxyTrace.push(`has:${String(key)}`);
		return Reflect.has(target, key);
	},
	get(target, key, receiver) {
		proxyTrace.push(`get:${String(key)}`);
		return Reflect.get(target, key, receiver);
	},
});
console.log("flat-string", JSON.stringify(normalized("stop", "stop")));
console.log("flat-array", JSON.stringify(normalized(["first", "stop", "last"], "stop")));
console.log("flat-nested", JSON.stringify(normalized([["nested"], "stop"], "stop")));
console.log("flat-holey", JSON.stringify(normalized([, "first", , "stop", ,], "stop")));
console.log("flat-proxy", JSON.stringify([normalized(proxyArray, "stop"), proxyTrace]));
console.log(
	"flat-subclass",
	JSON.stringify(normalized(new FlatInput("first", "stop"), "stop")),
);
const objectProxy = new Proxy(
	{ key: "value" },
	{
		get() {
			throw new Error("IsArray must not invoke a get trap");
		},
	},
);
console.log("flat-object-proxy", normalized(objectProxy, objectProxy)[0]);

function flatSnapshot(input) {
	const visits = [];
	[input].flat().forEach((value) => {
		visits.push(value);
		input[1] = "replaced";
		input.push("appended");
	});
	return visits;
}
console.log("flat-snapshot", JSON.stringify(flatSnapshot(["first", "second"])));
function flatThrow(input) {
	const writes = [];
	try {
		[input].flat().some((value) => {
			writes.push({ value });
			throw new RangeError("stopped");
		});
	} catch (error) {
		writes.push(error.name);
	}
	return writes;
}
console.log(
	"flat-throw",
	JSON.stringify([flatThrow("scalar"), flatThrow(["array", "later"])]),
);
function flatEvery(input) {
	return [input].flat().every((value, index) => value !== index);
}
console.log(
	"flat-every",
	JSON.stringify([flatEvery(0), flatEvery(2), flatEvery([1, 1, 3])]),
);
function flatReceiver(input) {
	return [input]
		.flat()
		.some((value, index, array) => array[index] === value && array.length === 1);
}
console.log(
	"flat-receiver",
	JSON.stringify([flatReceiver("value"), flatReceiver([1, 2])]),
);
const revoked = Proxy.revocable([], {});
revoked.revoke();
const revokedOrder = [];
function observeThis() {
	revokedOrder.push("argument");
	return {};
}
try {
	[revoked.proxy].flat().some((value) => {
		revokedOrder.push(value);
		return true;
	}, observeThis());
} catch (error) {
	revokedOrder.push(error.name);
}
console.log("flat-revoked", JSON.stringify(revokedOrder));

const original = Array.prototype.some;
try {
	Array.prototype.some = function (callback) {
		return callback(this[1], 1, this);
	};
	console.log("patched", JSON.stringify(inspect(["2", "-7", "9"], "match")));
} catch (error) {
	if (!(error instanceof TypeError)) throw error;
	console.log("patched", "locked");
} finally {
	if (Array.prototype.some !== original) Array.prototype.some = original;
}
