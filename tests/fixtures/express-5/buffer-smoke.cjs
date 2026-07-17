"use strict";

/* eslint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

const SaferBuffer = require("safer-buffer").Buffer;

const value = SaferBuffer.concat([
	SaferBuffer.from("express", "utf8"),
	SaferBuffer.from([0x2d, 0x35]),
]);

console.log(
	"RESULT " +
		(SaferBuffer.isBuffer(value) &&
		value.toString() === "express-5" &&
		SaferBuffer.byteLength("hé") === 3
			? "1/1"
			: "0/1"),
);
