import { createWorkerUrl } from "maligator:workers";

export const tasks = createWorkerUrl<typeof import("./sum.ts")>(
	"./sum.ts",
	import.meta.url,
);

console.log(Object.isFrozen(tasks), tasks.href.startsWith("file:"));
