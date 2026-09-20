"use strict";

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("inline-collection-storage requires MAL_HOST_GC=1");
}

let checks = 0;
function check(name, condition) {
	if (!condition) throw new Error("inline-collection-storage failure: " + name);
	checks++;
}

function exercise(seed) {
	const array = [seed, seed + 1, seed + 2, seed + 3];
	array.push(seed + 4);
	array[7] = seed + 7;
	check(
		"array promotion",
		array.length === 8 &&
			array[0] === seed &&
			array[4] === seed + 4 &&
			array[7] === seed + 7,
	);

	const map = new Map();
	Map.prototype.set.call(map, seed, { value: seed });
	Map.prototype.set.call(map, seed + 1, { value: seed + 1 });
	gc();
	check("map trace", Map.prototype.get.call(map, seed).value === seed);
	check("map delete", Map.prototype.delete.call(map, seed));
	Map.prototype.set.call(map, seed + 2, { value: seed + 2 });
	Map.prototype.clear.call(map);
	Map.prototype.set.call(map, seed + 3, { value: seed + 3 });
	gc();
	check(
		"map clear",
		map.size === 1 && Map.prototype.get.call(map, seed + 3).value === seed + 3,
	);

	const set = new Set();
	Set.prototype.add.call(set, seed);
	Set.prototype.add.call(set, seed + 1);
	gc();
	check("set trace", Set.prototype.has.call(set, seed + 1));
	check("set delete", Set.prototype.delete.call(set, seed));
	Set.prototype.add.call(set, seed + 2);
	Set.prototype.clear.call(set);
	Set.prototype.add.call(set, seed + 3);
	gc();
	check("set clear", set.size === 1 && Set.prototype.has.call(set, seed + 3));

	return array[4] + Map.prototype.get.call(map, seed + 3).value + set.size;
}

let checksum = 0;
for (let seed = 0; seed < 40; seed++) checksum += exercise(seed);
check("checksum", checksum === 1880);

console.log(
	checks === 281 ? "inline-collection-storage PASS" : "inline-collection-storage FAIL",
);
