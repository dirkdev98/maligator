function project(receiver) {
	const left = receiver.left;
	const right = receiver.right;
	return left ^ right ^ 7;
}

function projectPairNumbers(receiver) {
	return receiver.left + receiver.right;
}

function projectThree(receiver) {
	return receiver.left + receiver.right + receiver.kind;
}

function projectFour(receiver) {
	return receiver.left + receiver.right + receiver.kind + receiver.tag;
}

function projectAcross(receiver, other) {
	return receiver.left + receiver.right + other.kind;
}

let checksum = 0;
const stable = { left: 3, right: 5, kind: 7, tag: 11 };
const stableOther = { kind: 13 };
for (let index = 0; index < 200; index++) {
	checksum += project(stable);
	checksum += projectThree(stable);
	checksum += projectFour(stable);
	checksum += projectAcross(stable, stableOther);
}

let currentRight = 7;
const accessOrder = [];
const accessor = {
	get left() {
		accessOrder.push("left");
		currentRight = 11;
		return 2;
	},
	get right() {
		accessOrder.push("right");
		return currentRight;
	},
	get kind() {
		accessOrder.push("kind");
		return 13;
	},
	get tag() {
		accessOrder.push("tag");
		return 17;
	},
};
checksum += project(accessor);
checksum += projectThree(accessor);
checksum += projectFour(accessor);

const proxyOrder = [];
const proxy = new Proxy(
	{ left: 13, right: 17, kind: 19, tag: 23 },
	{
		get(target, key, receiver) {
			proxyOrder.push(key);
			return Reflect.get(target, key, receiver);
		},
	},
);
checksum += project(proxy);
checksum += projectThree(proxy);
checksum += projectFour(proxy);

if (checksum !== 12831) throw new Error(`checksum ${checksum}`);
if (accessOrder.join(",") !== "left,right,left,right,kind,left,right,kind,tag") {
	throw new Error(`accessor order ${accessOrder.join(",")}`);
}
if (proxyOrder.join(",") !== "left,right,left,right,kind,left,right,kind,tag") {
	throw new Error(`proxy order ${proxyOrder.join(",")}`);
}

const numericEdges = [
	[-0, -0, -0, -0, -0, -0],
	[2147483647, 1, -2, 0, 2147483646, 2147483648],
	[-2147483648, -1, 2, 0, -2147483647, -2147483649],
	[1.25, 2.5, -0.75, 0, 3, 3.75],
	[Infinity, -Infinity, 1, 0, NaN, NaN],
	[-Infinity, 1, 2, 0, -Infinity, -Infinity],
	[5e-324, 0, 0, 0, 5e-324, 5e-324],
	[1e100, -1e100, 7, 0, 7, 0],
	[NaN, 1, 2, 0, NaN, NaN],
	[1, 2, NaN, 0, NaN, 3],
];
for (let round = 0; round < 20; round++) {
	for (const values of numericEdges) {
		stable.left = values[0];
		stable.right = values[1];
		stable.kind = values[2];
		stable.tag = values[3];
		if (!Object.is(projectPairNumbers(stable), values[5])) {
			throw new Error("numeric pair projection changed a Number");
		}
		if (!Object.is(projectThree(stable), values[4])) {
			throw new Error("numeric triple projection changed a Number");
		}
		if (!Object.is(projectFour(stable), values[4])) {
			throw new Error("numeric quad projection changed a Number");
		}
	}
}
stable.left = "1";
stable.right = 2;
stable.kind = 3;
stable.tag = 4;
if (
	projectPairNumbers(stable) !== "12" ||
	projectThree(stable) !== "123" ||
	projectFour(stable) !== "1234"
) {
	throw new Error("nonnumeric projection did not resume string addition");
}
stable.left = {
	valueOf() {
		stable.kind = 9;
		return 1;
	},
};
stable.kind = 3;
if (projectPairNumbers(stable) !== 3) {
	throw new Error("pair projection did not resume numeric coercion");
}
stable.kind = 3;
if (projectThree(stable) !== 12) {
	throw new Error("triple projection read a later property before numeric coercion");
}
stable.kind = 3;
if (projectFour(stable) !== 16) {
	throw new Error("quad projection read a later property before numeric coercion");
}

// A fused operand chain that finishes inside the projection must still reach it.
function measureFusedOperands(headerLines, groups) {
	const header = headerLines.reduce((total, line) => total + line.length, 0);
	const record = (parts) => ({
		parts,
		indices: parts.map((_, index) => index),
		left: parts.reduce((total, part) => total + part.length, 0),
		right: parts.reduce((total, part) => total + part.length * 2, 0),
	});
	const measure = (lines, part) => {
		const lineCount = lines + part.indices.length + 1 + part.parts.length;
		return header + part.left + part.right + lineCount - 1;
	};
	return groups.map((group) => measure(headerLines.length, record(group)));
}
if (
	measureFusedOperands(["#a", "#bc"], [["x", "yz"], ["abc"], []]).join() !== "20,18,7"
) {
	throw new Error("projection dropped a fused numeric operand");
}

console.log("static-property-projection PASS");
