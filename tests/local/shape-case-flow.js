let checks = 0;
const ok = function (name, condition) {
	if (!condition) throw new Error("shape-case failure: " + name);
	checks++;
};

const object = {
	x: 1,
	y: 2,
	z: 3,
	sum3(count) {
		let total = 0;
		for (let index = 0; index < count; index++) {
			const x = this.x;
			const y = this.y;
			const z = this.z;
			total += x + y + z;
		}
		return total;
	},
};

ok("exact shape hit", object.sum3(4) === 24);

let accessorGets = 0;
Object.defineProperty(object, "x", {
	configurable: true,
	get() {
		accessorGets++;
		return 4;
	},
});
ok("accessor fallback", object.sum3(3) === 27);
ok("accessor count", accessorGets === 3);

const method = object.sum3;
const proxyGets = [];
const proxy = new Proxy(
	{ x: 7, y: 8, z: 9 },
	{
		get(target, key, receiver) {
			proxyGets.push(key);
			return Reflect.get(target, key, receiver);
		},
	},
);
ok("proxy fallback", method.call(proxy, 1) === 24);
ok("proxy get order", proxyGets.join(",") === "x,y,z");

Object.defineProperty(object, "z", {
	configurable: true,
	get() {
		throw new Error("shape-case getter throw");
	},
});
let message = "";
try {
	object.sum3(1);
} catch (error) {
	message = error.message;
}
ok("throw fallback", message === "shape-case getter throw");

if (checks !== 6) throw new Error("shape-case check count: " + checks);
console.log("shape-case-flow PASS");
