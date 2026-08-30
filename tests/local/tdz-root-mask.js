let initialized = { value: 17 };

function readInitialized() {
	return initialized;
}

let checksum = 0;
for (let index = 0; index < 20_000; index++) {
	checksum += readInitialized().value;
}

function readBeforeInitialization(survivor) {
	let message;
	try {
		message = unavailable;
	} catch (error) {
		if (!(error instanceof ReferenceError)) throw error;
		if (survivor.value !== 42) throw new Error("live root was lost");
		message = error.message;
	}
	let unavailable = 1;
	return message;
}

const message = readBeforeInitialization({ value: 42 });
if (checksum !== 340_000) throw new Error("initialized TDZ fast path");
if (message !== "Cannot access 'unavailable' before initialization") {
	throw new Error("TDZ fallback message");
}

console.log("tdz-root-mask PASS");
