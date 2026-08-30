let checks = 0;

function check(name, condition) {
	if (!condition) throw new Error(`FAIL ${name}`);
	checks++;
}

function consequentBounds(value) {
	const index = value | 0;
	if (index >= 0 && index < 16) return index % 16;
	return 99;
}

function alternateBounds(value) {
	const index = value | 0;
	if (index < 0) return 99;
	if (index >= 16) return 99;
	return index % 16;
}

function coerciveBounds(value) {
	if (value >= 0 && value < 16) return value % 16;
	return 99;
}

function consequentLoop() {
	let total = 0;
	for (let index = 0; index < 32; index++) {
		if (index < 16) total += index % 16;
	}
	return total;
}

function alternateLoop() {
	let total = 0;
	for (let index = 0; index < 32; index++) {
		if (index >= 16) continue;
		total += index % 16;
	}
	return total;
}

check("consequent lower endpoint", consequentBounds(0) === 0);
check("consequent upper endpoint", consequentBounds(15) === 15);
check("consequent rejects negative", consequentBounds(-1) === 99);
check("consequent rejects upper", consequentBounds(16) === 99);
check("alternate lower endpoint", alternateBounds(0) === 0);
check("alternate upper endpoint", alternateBounds(15) === 15);
check("alternate rejects negative", alternateBounds(-1) === 99);
check("alternate rejects upper", alternateBounds(16) === 99);
check("fraction remains fractional", coerciveBounds(3.5) === 3.5);
check("NaN remains rejected", coerciveBounds(NaN) === 99);
check("infinity remains rejected", coerciveBounds(Infinity) === 99);
check("negative zero survives remainder", Object.is(coerciveBounds(-0), -0));
check("consequent loop branch", consequentLoop() === 120);
check("alternate loop branch", alternateLoop() === 120);

let coercions = 0;
const coercive = {
	valueOf() {
		coercions++;
		return 7.5;
	},
};
check("boxed comparisons remain coercive", coerciveBounds(coercive) === 7.5);
check("boxed coercion count", coercions === 3);
check("checks ran", checks === 16);
console.log("numeric-branch-ranges PASS");
