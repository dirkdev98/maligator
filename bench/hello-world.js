// Size-bench floor: the smallest real program. Under compile-time feature flags
// the emitted source barely moves the binary — its size is dominated by the
// runtime archives + the selected build config — so this isolates each config's
// fixed cost (the "pay for what you use" floor per profile).
console.log("hello world");
