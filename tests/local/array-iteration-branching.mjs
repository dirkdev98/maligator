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
