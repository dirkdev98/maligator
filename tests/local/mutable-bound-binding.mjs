// Bindings that hold Function.prototype.bind results while bind itself is replaced:
// a bound function created before the replacement keeps calling its target, and
// replacements that retarget, add an argument or return a plain function each reach
// their own result, also when the binding is rebound in the middle of a loop.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

const FunctionPrototype = Function.prototype;
const originalBind = FunctionPrototype.bind;
let replacements = 0;

function receiverCall(prefix, value) {
	return prefix + value + this.offset;
}
function otherCall(prefix, value) {
	return prefix * 1000 + value - this.offset;
}
const receiver = { offset: 11 };

const early = receiverCall.bind(receiver, 5);
function callEarly(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += early(index & 63);
	return total;
}

// Every caller reaches the loop through this, so it stays one site.
const runners = [callEarly];
const loops = 40;
const rounds = 64;
let warm = 0;
for (let round = 0; round < loops; round++) warm += runners[0](rounds);
record("warm", warm);
record("loops", loops);
record("rounds", rounds);

FunctionPrototype.bind = function (thisArgument, ...prefix) {
	replacements++;
	return originalBind.call(otherCall, thisArgument, ...prefix);
};
record("early-after-replacement", callEarly(8));
const retargeted = receiverCall.bind(receiver, 5);
function callRetargeted(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += retargeted(index);
	return total;
}
record("retargeted", callRetargeted(8));

FunctionPrototype.bind = function (thisArgument, ...prefix) {
	replacements++;
	return originalBind.call(this, thisArgument, ...prefix, 99);
};
const extended = receiverCall.bind(receiver, 5);
function callExtended(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) total += extended(index);
	return total;
}
record("extended", callExtended(8));

FunctionPrototype.bind = function (thisArgument, ...prefix) {
	replacements++;
	return (value) => `plain:${prefix.join(",")}:${value}:${typeof thisArgument}`;
};
const plain = receiverCall.bind(receiver, 5);
function callPlain(rounds) {
	const seen = [];
	for (let index = 0; index < rounds; index++) seen.push(plain(index));
	return seen.join("|");
}
record("plain", callPlain(3));

FunctionPrototype.bind = originalBind;
let current = receiverCall.bind(receiver, 5);
function midLoop(rounds) {
	let total = 0;
	for (let index = 0; index < rounds; index++) {
		if (index === rounds >> 1) {
			FunctionPrototype.bind = function (thisArgument, ...prefix) {
				replacements++;
				return originalBind.call(otherCall, { offset: 1 }, ...prefix);
			};
			current = receiverCall.bind(receiver, 5);
			FunctionPrototype.bind = originalBind;
		}
		total += current(index);
	}
	return total;
}
record("mid-loop", midLoop(16));
current = receiverCall.bind(receiver, 5);
record("restored", midLoop(4));
record("early-restored", callEarly(8));
record("replacements", replacements);

console.log(results.join("\n"));
