function loadProbe(value) {
	return value.probe;
}

const proto = { probe: 1 };
const receiver = Object.create(proto);
let total = 0;
for (let i = 0; i < 10; i++) total += loadProbe(receiver);
proto.probe = 2;
for (let i = 0; i < 5; i++) total += loadProbe(receiver);

if (total !== 20) throw new Error("FAIL inherited property slot cache");
console.log("inherited-property-slot-cache PASS");
