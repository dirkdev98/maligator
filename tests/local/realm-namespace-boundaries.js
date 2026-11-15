globalThis.realmProbe = function realmProbe(value) {
	return Math.abs(+value) + (Number.isFinite(value) ? 1 : 0);
};
globalThis.realmReplaceNumber = function realmReplaceNumber() {
	Number.isFinite = () => false;
};
