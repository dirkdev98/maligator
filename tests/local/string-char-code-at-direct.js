let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function codeUnit(value, position) {
	return value.charCodeAt(position);
}

let checksum = 0;
for (let i = 0; i < 5000; i++) {
	checksum += codeUnit("Maligator", i & 7);
}
ok("hot primitive string", checksum === 508750);

ok("missing position", "ABC".charCodeAt() === 65);
ok("negative position", Number.isNaN(codeUnit("ABC", -1)));
ok("past end", Number.isNaN(codeUnit("ABC", 3)));
ok("fractional position", codeUnit("ABC", 1.9) === 66);
ok("NaN position", codeUnit("ABC", NaN) === 65);
ok("undefined position", codeUnit("ABC", undefined) === 65);

function exactLiteral(position) {
	return "Maligator".charCodeAt(position);
}
ok("locked exact literal", exactLiteral(3) === 105);

let coercions = 0;
const position = {
	valueOf() {
		coercions++;
		return 2;
	},
};
ok("position coercion", codeUnit("ABC", position) === 67 && coercions === 1);

const ownMethod = {
	charCodeAt(value) {
		return this.marker + value;
	},
	marker: 40,
};
ok("non-string receiver", codeUnit(ownMethod, 2) === 42);

function boundedChecksum(value) {
	let checksum = 0;
	for (let index = 0; index < value.length; index++) {
		checksum += value.charCodeAt(index);
	}
	return checksum;
}
ok("bounded primitive loop", boundedChecksum("A\ud83d\ude00Z") === 112344);

function concatenate(left, right) {
	return left + right;
}

const flatChildren = concatenate("left-flat", "RIGHT-FLAT");
ok("cons left child", flatChildren.charCodeAt(0) === 108);
ok("cons left boundary", flatChildren.charCodeAt(8) === 116);
ok("cons right boundary", flatChildren.charCodeAt(9) === 82);
ok("cons right child", flatChildren.charCodeAt(flatChildren.length - 1) === 84);

const dependentLeft = "__dependent-left__".slice(2, 16);
const dependentRight = "__DEPENDENT-RIGHT__".slice(2, 17);
const dependentChildren = concatenate(dependentLeft, dependentRight);
ok("dependent left child", dependentChildren.charCodeAt(3) === 101);
ok(
	"dependent right child",
	dependentChildren.charCodeAt(dependentLeft.length + 3) === 69,
);

const splitSurrogate = concatenate("split-\ud83d", "\ude00-pair");
ok("split surrogate left unit", splitSurrogate.charCodeAt(6) === 0xd83d);
ok("split surrogate right unit", splitSurrogate.charCodeAt(7) === 0xde00);

const nestedRight = concatenate("LEFT", concatenate("right-", "nested"));
ok(
	"nested right child keeps root index on flatten",
	nestedRight.charCodeAt(nestedRight.length - 1) === 100,
);

const coerciveRope = concatenate("coercive-", "rope");
ok(
	"coercion GC keeps cons children",
	coerciveRope.charCodeAt({
		valueOf() {
			if (typeof gc === "function") gc();
			return 9;
		},
	}) === 114,
);

function mismatchedBound(bound, value) {
	let result = 0;
	for (let index = 0; index < bound.length; index++) {
		result += value.charCodeAt(index);
	}
	return result;
}
ok("mismatched receiver keeps bounds", Number.isNaN(mismatchedBound("long", "x")));

const original = String.prototype.charCodeAt;
function mutateThenRead(value, index) {
	String.prototype.charCodeAt = function (position) {
		return this.length + position;
	};
	return value.charCodeAt(index);
}
ok("same-activation epoch invalidation", mutateThenRead("epoch", 3) === 8);
String.prototype.charCodeAt = original;

String.prototype.charCodeAt = function (value) {
	return this.length + value;
};
ok("prototype replacement", codeUnit("override", 3) === 11);
String.prototype.charCodeAt = original;
ok("restored method remains conformant", codeUnit("Z", 0) === 90);

function mutateWhileEvaluatingPosition(value) {
	return value.charCodeAt(
		((String.prototype.charCodeAt = function () {
			return 999;
		}),
		0),
	);
}
ok("method captured before argument mutation", mutateWhileEvaluatingPosition("A") === 65);
String.prototype.charCodeAt = original;

ok("checks ran", passed === 26);
console.log("string-char-code-at-direct PASS");
