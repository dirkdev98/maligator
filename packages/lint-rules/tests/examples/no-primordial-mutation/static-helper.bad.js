// Adding a helper to a built-in throws in the default build, which locks built-ins.
Math.clamp = (value, low, high) => Math.min(Math.max(value, low), high);

console.log(Math.clamp(12, 0, 10), Math.clamp(-3, 0, 10));
