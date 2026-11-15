function countOverlap() {
	return arguments.length * 10 + arguments[0];
}
function swapCycle() {
	return arguments[1] * 10 + arguments[0];
}
function threeCycle() {
	return arguments[1] * 100 + arguments[2] * 10 + arguments[0];
}

globalThis.snapshotOperations = [countOverlap, swapCycle, threeCycle];
let checksum = 0;
for (const operation of globalThis.snapshotOperations) checksum += operation(4, 7, 8);
if (checksum !== 892) throw new Error("argument snapshot moves lost values");
console.log("arguments-snapshot-costs PASS");
