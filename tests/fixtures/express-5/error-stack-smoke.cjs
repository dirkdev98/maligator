"use strict";

/* oxlint-disable -- This compatibility fixture intentionally runs pinned CommonJS packages. */

const depd = require("depd");
const createError = require("http-errors");
const depdPackage = require("depd/package.json");
const httpErrorsPackage = require("http-errors/package.json");

let passed = 0;
let total = 0;

function check(condition) {
	total++;
	if (condition) passed++;
}

check(depdPackage.version === "2.0.0");
check(httpErrorsPackage.version === "2.0.1");

const deprecate = depd("maligator-error-stack-smoke");
check(
	typeof deprecate === "function" &&
		deprecate._namespace === "maligator-error-stack-smoke",
);

const teapot = createError(418, "short and stout");
check(
	teapot instanceof Error &&
		teapot.status === 418 &&
		teapot.statusCode === 418 &&
		teapot.message === "short and stout" &&
		typeof teapot.stack === "string",
);

const missing = new createError.NotFound("missing");
check(
	missing instanceof Error &&
		missing.status === 404 &&
		missing.name === "NotFoundError" &&
		missing.stack.indexOf("NotFoundError: missing") === 0,
);

console.log("RESULT " + passed + "/" + total);
