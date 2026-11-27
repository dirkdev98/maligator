// Reading each global by name lets the build keep only the installers it reads.
console.log(
	typeof globalThis.setTimeout === "function",
	typeof globalThis.queueMicrotask === "function",
);
