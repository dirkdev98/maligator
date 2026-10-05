`execution` is a deeply immutable snapshot of the command and resolved configuration used to compile the application. It is not the launched process's current arguments, environment, working directory, or PID. Use supported Node process APIs for runtime values.

```typescript context.ts
import { execution } from "maligator:process";

console.log(execution.command);
console.log(execution.production);
console.log(execution.config.engine.regexp);
```

Run `maligator run context.ts` to observe `run`, `false`, and the configured RegExp policy. `build --production` records production intent; profiling uses production optimizations without changing the original command's intent. Snapshot values remain fixed when a built executable is launched with different arguments or environment variables.

See [CLI options](/api/cli) for the commands that populate the snapshot and [production builds](/guides/production) for the difference between build-time and runtime settings.
