globalThis.asyncFailureCount = (globalThis.asyncFailureCount ?? 0) + 1;
await Promise.reject(globalThis.moduleFailure);
