// Each async function holds a projection pattern that an ordinary function would specialize.
async function exec(p) {
	const match = /a(b+)c/.exec(await p);
	return match === null ? "" : match[1];
}
async function iterate(p) {
	let total = 0;
	for (const match of (await p).matchAll(/b(\d)/g)) total += Number(match[1]);
	return total;
}
async function pair(p) {
	const point = { x: await p, y: 2 };
	return point.x + point.y;
}
async function slice(p) {
	return Number((await p).slice(1, 3));
}
async function split(p) {
	return (await p).split("\r\n")[0].slice(2);
}
const results = await Promise.all([
	exec(Promise.resolve("xabbc")),
	iterate(Promise.resolve("b1b2b3")),
	pair(Promise.resolve(40)),
	slice(Promise.resolve("x42y")),
	split(Promise.resolve("--abc\r\nxyz")),
]);
console.log(results.join(","));
