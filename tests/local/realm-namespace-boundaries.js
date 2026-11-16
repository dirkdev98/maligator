globalThis.realmProbe = function realmProbe(value) {
	return Math.abs(+value) + (Number.isFinite(value) ? 1 : 0);
};
globalThis.realmReplaceNumber = function realmReplaceNumber() {
	Number.isFinite = () => false;
};
globalThis.realmClock = function realmClock() {
	return Date.now() >= 1577836800000 ? 1 : 0;
};
globalThis.realmReplaceClock = function realmReplaceClock() {
	Date.now = () => 17;
};
