const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

const wideningBuffer = new ArrayBuffer(4);
const wideningSource = new Uint8Array(wideningBuffer, 0, 2);
wideningSource.set([1, 2]);
const wideningTarget = new Uint16Array(wideningBuffer);
wideningTarget.set(wideningSource);
check(
	"widening overlap snapshots unread source bytes",
	wideningTarget[0] === 1 && wideningTarget[1] === 2,
);

const narrowingBuffer = new ArrayBuffer(4);
const narrowingSource = new Uint16Array(narrowingBuffer);
narrowingSource.set([0x0102, 0x0304]);
const narrowingTarget = new Uint8Array(narrowingBuffer);
narrowingTarget.set(narrowingSource, 2);
check(
	"narrowing overlap snapshots unread source bytes",
	narrowingTarget[2] === 2 && narrowingTarget[3] === 4,
);

const bigintBuffer = new ArrayBuffer(24);
const bigintSource = new BigInt64Array(bigintBuffer, 0, 2);
bigintSource.set([1n, 2n]);
const bigintTarget = new BigUint64Array(bigintBuffer, 8, 2);
bigintTarget.set(bigintSource);
check(
	"BigInt overlap roots snapshotted values across conversion",
	bigintTarget[0] === 1n && bigintTarget[1] === 2n,
);

for (const [name, passed] of results) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"RESULT " + results.filter(([, passed]) => passed).length + "/" + results.length,
);
