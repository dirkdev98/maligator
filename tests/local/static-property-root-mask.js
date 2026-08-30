const checkpoints = [];

function checkpoint(value) {
	const holder = [value];
	checkpoints.push(holder);
	if (checkpoints.length > 16) checkpoints.length = 0;
	return holder;
}

function readValueThenSafepoint(receiver, survivor) {
	const value = receiver.value;
	const holder = checkpoint(survivor);
	if (holder[0] !== survivor || survivor.marker !== 42) {
		throw new Error("property-load survivor was lost");
	}
	return value;
}

function callFloorThenSafepoint(value, survivor) {
	const floor = Math.floor;
	const holder = checkpoint(survivor);
	if (holder[0] !== survivor || survivor.marker !== 42) {
		throw new Error("watched-load survivor was lost");
	}
	return floor(value);
}

const survivor = { marker: 42 };
const own = { value: 11 };
const prototype = { value: 13 };
const inherited = Object.create(prototype);
let checksum = 0;

for (let index = 0; index < 200; index++) {
	checksum += readValueThenSafepoint(own, survivor);
	checksum += readValueThenSafepoint(inherited, survivor);
}

for (let index = 0; index < 100; index++) {
	checksum += callFloorThenSafepoint(7.9, survivor);
}

let getterCalls = 0;
const accessor = {
	get value() {
		getterCalls++;
		return 15;
	},
};
checksum += readValueThenSafepoint(accessor, survivor);

let proxyCalls = 0;
const proxy = new Proxy(
	{ value: 17 },
	{
		get(target, key, receiver) {
			if (key === "value") proxyCalls++;
			return Reflect.get(target, key, receiver);
		},
	},
);
checksum += readValueThenSafepoint(proxy, survivor);

const originalFloor = Math.floor;
Math.floor = function () {
	return 19;
};
checksum += callFloorThenSafepoint(7.9, survivor);
Math.floor = originalFloor;
checksum += callFloorThenSafepoint(7.9, survivor);

if (checksum !== 5_558) throw new Error(`checksum ${checksum}`);
if (getterCalls !== 1) throw new Error(`getter calls ${getterCalls}`);
if (proxyCalls !== 1) throw new Error(`proxy calls ${proxyCalls}`);

console.log("static-property-root-mask PASS");
