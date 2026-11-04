const globals = globalThis as typeof globalThis & { fragmentCount?: number };
globals.fragmentCount = (globals.fragmentCount ?? 0) + 1;
