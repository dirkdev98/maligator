import { literal, safeParse, strictObject, variant } from "valibot";

const schema = variant("type", [
	strictObject({ type: literal("first") }),
	strictObject({ type: literal("second") }),
]);

const result = safeParse(schema, { type: "first" });

if (!result.success || result.output.type !== "first") {
	throw new Error("Valibot variant parsing returned the wrong result");
}

console.log("valibot-variant PASS 1/1");
