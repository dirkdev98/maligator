import { double } from "./math.ts";
import type { Label, Model } from "./types.ts";

const model: Model = { value: 21 };
const label: Label = "answer";

function format(name: string, value: number): string {
	return `${name}:${value}`;
}

format(label, double(model.value));
