const checks = [];
const object = {};

for (let i = 0; i < 8; i++) {
	object["p" + i] = i * 3;
}

let checksum = 0;
for (let round = 0; round < 1000; round++) {
	for (let i = 0; i < 24; i++) {
		checksum += object["p" + (i % 8)];
	}
}
checks.push(checksum === 252000);

const headers = [];
for (let i = 0; i < 12; i++) headers.push("h" + i);
checks.push(headers.join(",") === "h0,h1,h2,h3,h4,h5,h6,h7,h8,h9,h10,h11");

const map = new Map();
for (let i = 0; i < 8; i++) map.set("p" + i, i + 10);
checks.push(map.get("p0") === 10 && map.get("p7") === 17);
checks.push(Object.keys(object).join("|") === "p0|p1|p2|p3|p4|p5|p6|p7");

function sumFinite(source) {
	let total = 0;
	for (let i = 0; i < 8; i++) total += source["p" + (i % 8)];
	return total;
}

checks.push(sumFinite(object) === 84);
object.p3 = 100;
checks.push(sumFinite(object) === 175);
delete object.p4;
Object.setPrototypeOf(object, { p4: 44 });
checks.push(sumFinite(object) === 207);
object.p4 = 12;
checks.push(sumFinite(object) === 175);

let proxyReads = 0;
const proxy = new Proxy(object, {
	get(target, key, receiver) {
		proxyReads++;
		return Reflect.get(target, key, receiver);
	},
});
checks.push(sumFinite(proxy) === 175 && proxyReads === 8);

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
