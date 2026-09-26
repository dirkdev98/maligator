function* heldAcrossTeardown() {
	const retained = { value: 17 };
	yield retained.value;
	return retained.value;
}

globalThis.__heldAcrossTeardown = heldAcrossTeardown();
if (globalThis.__heldAcrossTeardown.next().value !== 17) {
	throw new Error("generator failed to suspend");
}
