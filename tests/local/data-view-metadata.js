let checks = 0;
function equal(actual, expected, label) {
	checks++;
	if (actual !== expected) {
		throw new Error(`${label}: expected ${expected}, received ${actual}`);
	}
}

function metadata(view, length, offset, label) {
	equal(view.byteLength, length, `${label} byteLength`);
	equal(view.byteOffset, offset, `${label} byteOffset`);
}

function rejectsAccess(view, label) {
	for (const access of [() => view.getUint8(0), () => view.setUint8(0, 1)]) {
		let rejected = false;
		try {
			access();
		} catch (error) {
			rejected = error instanceof TypeError;
		}
		equal(rejected, true, `${label} data access`);
	}
}

const buffer = new ArrayBuffer(16, { maxByteLength: 32 });
const fixed = new DataView(buffer, 4, 8);
const tracking = new DataView(buffer, 4);
const empty = new DataView(buffer, 4, 0);
metadata(fixed, 8, 4, "fixed");
metadata(tracking, 12, 4, "tracking");
metadata(empty, 0, 4, "empty");

buffer.resize(8);
metadata(fixed, 0, 0, "fixed beyond end");
metadata(tracking, 4, 4, "tracking within end");
metadata(empty, 0, 4, "empty within end");
rejectsAccess(fixed, "fixed beyond end");

buffer.resize(2);
for (const view of [fixed, tracking, empty]) {
	metadata(view, 0, 0, "offset beyond end");
	rejectsAccess(view, "offset beyond end");
}

buffer.resize(16);
metadata(fixed, 8, 4, "fixed recovered");
metadata(tracking, 12, 4, "tracking recovered");
metadata(empty, 0, 4, "empty recovered");

buffer.transfer();
for (const view of [fixed, tracking, empty]) {
	metadata(view, 0, 0, "detached");
	rejectsAccess(view, "detached");
}

console.log(`RESULT ${checks}/${checks}`);
