function project(receiver) {
	const left = receiver.left;
	const right = receiver.right;
	return left * 31 + right;
}

let checksum = 0;
const stable = { left: 3, right: 5 };
for (let index = 0; index < 200; index++) checksum += project(stable);

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
};
checksum += project(accessor);

const proxyOrder = [];
const proxy = new Proxy(
	{ left: 13, right: 17 },
	{
		get(target, key, receiver) {
			proxyOrder.push(key);
			return Reflect.get(target, key, receiver);
		},
	},
);
checksum += project(proxy);

if (checksum !== 20_093) throw new Error(`checksum ${checksum}`);
if (accessOrder.join(",") !== "left,right") {
	throw new Error(`accessor order ${accessOrder.join(",")}`);
}
if (proxyOrder.join(",") !== "left,right") {
	throw new Error(`proxy order ${proxyOrder.join(",")}`);
}

console.log("static-property-projection PASS");
