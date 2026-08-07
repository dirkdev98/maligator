// crypto.getRandomValues over views whose backing store has gone away.
//
// A detached buffer and a fixed-length view left out of bounds by a shrunk
// resizable buffer both compute a zero byte length. Testing the length alone
// made the call "succeed" having written nothing, handing back an array the
// caller believes is random — so both must be refused instead.
const results = [];
function check(name, ok) {
	results.push([name, !!ok]);
}

function threw(fn) {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

const filled = new Uint8Array(16);
crypto.getRandomValues(filled);
check(
	"a live view is filled",
	filled.some((byte) => byte !== 0),
);

const view = new Uint8Array(16);
view.buffer.transfer();
check(
	"a detached view is refused",
	threw(() => crypto.getRandomValues(view)),
);

const resizable = new ArrayBuffer(16, { maxByteLength: 32 });
const fixed = new Uint8Array(resizable, 8, 8);
resizable.resize(8);
check(
	"an out-of-bounds view is refused",
	threw(() => crypto.getRandomValues(fixed)),
);

// A length-tracking view over the same shrunk buffer is still in bounds, so it
// keeps working over whatever remains.
const tracking = new Uint8Array(resizable, 0);
crypto.getRandomValues(tracking);
check(
	"a length-tracking view over a shrunk buffer is filled",
	tracking.length === 8 && tracking.some((byte) => byte !== 0),
);

// The quota is unchanged.
check(
	"a view past the 65536-byte quota is refused",
	threw(() => crypto.getRandomValues(new Uint8Array(65537))),
);
check(
	"an empty view is accepted",
	!threw(() => crypto.getRandomValues(new Uint8Array(0))),
);

const passed = results.filter(([, ok]) => ok).length;
for (const [name, ok] of results) if (!ok) console.log(`FAIL ${name}`);
console.log(`RESULT ${passed}/${results.length}`);
