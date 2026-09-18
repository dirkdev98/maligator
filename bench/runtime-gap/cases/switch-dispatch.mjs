import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function switchDispatch(scale) {
	let checksum = 0;
	const operations = 900_000 * scale;
	for (let index = 0; index < operations; index++) {
		switch ((index * 17) & 7) {
			case 0:
			case 3:
				checksum += index & 31;
				break;
			case 1:
			case 6:
				checksum ^= index & 255;
				break;
			case 2:
			case 5:
				checksum -= index & 15;
				break;
			default:
				checksum += 7;
		}
	}
	return result(checksum, operations);
}

runRuntimeGapCase("switch-dispatch", switchDispatch);
