// Array element access: build dense arrays and read them in tight loops — the
// path the dense element vector turns from a hash lookup into an O(1) load.
let acc = 0;
for (let iter = 0; iter < 2000; iter++) {
	const a = [];
	for (let i = 0; i < 1000; i++) a[i] = i;     // contiguous dense writes
	let s = 0;
	for (let i = 0; i < 1000; i++) s += a[i];     // dense reads
	for (let i = 0; i < 1000; i++) s += a[(i * 7) % 1000]; // scattered in-range reads
	acc += s;
}
console.log(acc);
