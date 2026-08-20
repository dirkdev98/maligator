const order = [];

class Ledger {
	constructor(id) {
		this.id = id;
		this.entries = [];
		this.total = 0;
	}

	add(value) {
		this.entries.push(value);
		this.total = (this.total + value) | 0;
		return this;
	}
}

class ResumedFailure extends Error {
	constructor(ledger, witness) {
		super("thrown after suspension");
		this.ledger = ledger;
		this.witness = witness;
	}
}

// Short-lived garbage around every suspension point, so a GC-stress collection
// lands while the resumed frame's ledger and witness are the only live roots.
function churn(count, seed) {
	let sum = 0;
	for (let index = 0; index < count; index++) {
		const cell = { index, tag: "cell:" + index, payload: [seed, index, seed ^ index] };
		sum = (sum + cell.payload[2] + cell.tag.length) | 0;
	}
	return sum;
}

async function probePrimordialMutation(sample) {
	await null;
	try {
		Array.prototype.coreParityProbe = function () {
			return this.length + 1;
		};
	} catch (error) {
		return error instanceof TypeError ? "locked:TypeError" : "locked:" + error.name;
	}
	const observed = sample.coreParityProbe();
	delete Array.prototype.coreParityProbe;
	return observed === sample.length + 1 && !("coreParityProbe" in Array.prototype)
		? "mutable:installed-and-restored"
		: "mutable:unexpected";
}

async function scenario() {
	const ledger = new Ledger("core-parity");
	const witness = { seen: 0, live: ledger };
	let checksum = churn(384, 7);

	order.push("enter");
	try {
		try {
			for (let index = 1; index <= 4; index++) ledger.add(index * index);
			checksum = (checksum + (await Promise.resolve(ledger.total))) | 0;
			order.push("resumed");
			checksum = (checksum + churn(256, 11)) | 0;
			throw new ResumedFailure(ledger, witness);
		} catch (error) {
			order.push("catch");
			if (!(error instanceof ResumedFailure)) throw error;
			// Identity, not equal data: the handler must reach the very object the
			// pre-suspension frame allocated, through both the error and the witness.
			if (error.ledger !== ledger || error.witness.live !== ledger) {
				throw new Error("handler lost the live ledger identity");
			}
			ledger.add(100);
			witness.seen = (witness.seen + 1) | 0;
			checksum = (checksum + (await Promise.resolve(ledger.entries.length))) | 0;
			order.push("catch-resumed");
			checksum = (checksum + churn(256, 13)) | 0;
			if (error.ledger.total !== 130 || error.ledger.entries.length !== 5) {
				throw new Error("ledger mutated across the handler suspension");
			}
		} finally {
			order.push("finally");
			checksum = (checksum + (await Promise.resolve(witness.seen))) | 0;
			order.push("finally-resumed");
			checksum = (checksum + churn(192, 17)) | 0;
			if (witness.live !== ledger) throw new Error("finally lost the live ledger");
		}
		order.push("after");
	} catch (error) {
		order.push("outer:" + error.message);
	}

	const primordial = await probePrimordialMutation(ledger.entries);
	checksum = (checksum + churn(192, 19)) | 0;
	return {
		order: order.join(">"),
		ledger: ledger.id + ":" + ledger.total + ":" + ledger.entries.join(","),
		witness: witness.seen,
		checksum,
		primordial,
	};
}

console.log(JSON.stringify(await scenario()));
