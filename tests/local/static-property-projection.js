function project(receiver) {
	const left = receiver.left;
	const right = receiver.right;
	return left ^ right ^ 7;
}

function projectThree(receiver) {
	return receiver.left + receiver.right + receiver.kind;
}

function projectFour(receiver) {
	return receiver.left + receiver.right + receiver.kind + receiver.tag;
}

let checksum = 0;
const stable = { left: 3, right: 5, kind: 7, tag: 11 };
for (let index = 0; index < 200; index++) {
	checksum += project(stable);
	checksum += projectThree(stable);
	checksum += projectFour(stable);
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

if (checksum !== 8631) throw new Error(`checksum ${checksum}`);
if (accessOrder.join(",") !== "left,right,left,right,kind,left,right,kind,tag") {
	throw new Error(`accessor order ${accessOrder.join(",")}`);
}
if (proxyOrder.join(",") !== "left,right,left,right,kind,left,right,kind,tag") {
	throw new Error(`proxy order ${proxyOrder.join(",")}`);
}

console.log("static-property-projection PASS");
