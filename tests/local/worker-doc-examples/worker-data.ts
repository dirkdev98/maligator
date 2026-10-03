import { workerData } from "maligator:workers";

function readConfig(value: unknown): { label: string } {
	if (
		typeof value !== "object" ||
		value === null ||
		!("label" in value) ||
		typeof value.label !== "string"
	) {
		throw new TypeError("Expected worker data with a string label");
	}
	return { label: value.label };
}

const config = readConfig(workerData);
console.log(config.label);
