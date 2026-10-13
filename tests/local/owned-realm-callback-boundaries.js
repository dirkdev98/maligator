globalThis.ownedSloppy = function ownedSloppy() {
	return this;
};
globalThis.ownedStrict = function ownedStrict() {
	"use strict";
	return this;
};
globalThis.ownedThrow = function ownedThrow() {
	throw new TypeError("owned realm marker");
};
