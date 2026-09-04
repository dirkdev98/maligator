function check(condition, message) {
	if (!condition) throw new Error(message);
}

const script = function (left, right) {
	return left + right;
};
const native = Math.max;
const bound = script.bind(null, 1);

function scriptLength() {
	return script.length;
}
function nativeLength() {
	return native.length;
}
function boundLength() {
	return bound.length;
}

let checksum = 0;
for (let index = 0; index < 2_000; index++) {
	checksum += scriptLength() + nativeLength() + boundLength();
}
check(checksum === 10_000, "callable own slots");

Object.defineProperty(script, "length", { value: 5, configurable: true });
check(scriptLength() === 5, "redefined length");

let getterCalls = 0;
Object.defineProperty(script, "length", {
	configurable: true,
	get() {
		getterCalls++;
		return 7;
	},
});
check(
	scriptLength() === 7 && scriptLength() === 7 && getterCalls === 2,
	"accessor length",
);

delete script.length;
check(scriptLength() === 0, "inherited length after delete");

console.log("function-own-slot-cache PASS");
