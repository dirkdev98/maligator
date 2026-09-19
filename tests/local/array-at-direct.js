let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("array-at-direct failure: " + name);
	checks++;
}

function read(array, index) {
	return array.at(index);
}

const values = [10, 20, 30];
ok("last", read(values, -1) === 30);
ok("first", read(values, 0) === 10);
ok("fraction", read(values, 1.9) === 20);
ok("nan", read(values, NaN) === 10);
ok("infinity", read(values, Infinity) === undefined);
ok("negative infinity", read(values, -Infinity) === undefined);
ok("out of range", read(values, 3) === undefined);
ok("omitted", values.at() === 10);

let inheritedReads = 0;
const hole = new Array(1);
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		inheritedReads++;
		return 41;
	},
});
ok("inherited hole getter", read(hole, 0) === 41 && inheritedReads === 1);
delete Array.prototype[0];

let coercions = 0;
const coerciveIndex = {
	valueOf() {
		coercions++;
		return -1;
	},
};
ok("coercive index fallback", read(values, coerciveIndex) === 30 && coercions === 1);

const own = [1, 2];
own.at = function (index) {
	return index + 100;
};
ok("own override", read(own, 2) === 102);

const intrinsicAt = Array.prototype.at;
Array.prototype.at = function () {
	return 77;
};
ok("prototype override", read(values, -1) === 77);
Array.prototype.at = intrinsicAt;

const mutationResult = values.at(
	((Array.prototype.at = function () {
		return 88;
	}),
	-1),
);
Array.prototype.at = intrinsicAt;
ok("mutation after method load", mutationResult === 30);

const proxy = new Proxy([4, 5], {});
ok("proxy receiver fallback", read(proxy, -1) === 5);
ok("generic receiver fallback", intrinsicAt.call({ 0: 9, length: 1 }, 0) === 9);

let extraEffects = 0;
ok(
	"extra arguments remain evaluated",
	values.at(-1, ++extraEffects) === 30 && extraEffects === 1,
);

console.log(checks === 16 ? "array-at-direct PASS" : "array-at-direct FAIL");
