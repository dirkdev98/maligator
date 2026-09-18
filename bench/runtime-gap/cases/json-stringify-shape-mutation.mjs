import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function addJsonChecksum(checksum, value) {
	for (let index = 0; index < value.length; index++) {
		checksum = (checksum * 33 + value.charCodeAt(index)) % MODULUS;
	}
	return checksum;
}

function jsonStringifyShapeMutation(scale) {
	let checksum = 0;
	const rounds = 2_000 * scale;
	for (let index = 0; index < rounds; index++) {
		const replacerSource = { first: index & 255, deleted: 2, changed: 3 };
		const replacerJson = JSON.stringify(replacerSource, function (key, value) {
			if (key === "first") {
				delete this.deleted;
				Object.defineProperty(this, "changed", {
					enumerable: false,
					configurable: true,
					get() {
						return 30;
					},
				});
				this.added = 4;
			}
			return value;
		});
		checksum = addJsonChecksum(checksum, replacerJson);

		const prototype = { later: 41 };
		const toJSONSource = {
			first: {
				toJSON() {
					delete toJSONSource.later;
					toJSONSource.added = 43;
					return 39;
				},
			},
			later: 4,
		};
		Object.setPrototypeOf(toJSONSource, prototype);
		checksum = addJsonChecksum(checksum, JSON.stringify(toJSONSource));

		const hiddenSource = { first: 1 };
		Object.defineProperty(hiddenSource, "hidden", {
			value: 2,
			enumerable: false,
			configurable: true,
		});
		const hiddenJson = JSON.stringify(hiddenSource, function (key, value) {
			if (key === "first") {
				Object.defineProperty(this, "hidden", { enumerable: true });
			}
			return value;
		});
		checksum = addJsonChecksum(checksum, hiddenJson);
	}
	return result(checksum, rounds * 3);
}

runRuntimeGapCase("json-stringify-shape-mutation", jsonStringifyShapeMutation);
