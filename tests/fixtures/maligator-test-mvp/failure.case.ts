import { expect, test } from "maligator:test";

test("shows structural differences", () => {
	expect({ status: 200, body: ["ok"] }).toEqual({
		status: 400,
		body: ["bad"],
	});
});
