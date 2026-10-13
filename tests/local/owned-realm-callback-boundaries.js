globalThis.ownedSloppy = function ownedSloppy() {
	globalThis.__mal_collect_garbage();
	return this;
};
globalThis.ownedStrict = function ownedStrict() {
	"use strict";
	return this;
};
globalThis.ownedThrow = function ownedThrow() {
	throw new TypeError("owned realm marker");
};
