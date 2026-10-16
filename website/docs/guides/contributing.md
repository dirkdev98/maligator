Use the source repository when changing the compiler, native runtime, or website. These commands test Maligator itself; application projects use [maligator test](/guides/testing).

## Set up the checkout

```shell
git clone https://github.com/dirkdev98/maligator.git
cd maligator
npm ci
npm run env:check -- --json
```

Source tooling needs Node.js 24 or newer, and native work needs the toolchain from [Set up native builds](/guides/native-toolchain). The environment probe checks workspace/cache writes and loopback access; resolve capability failures before diagnosing product code.

## Continue in the repository

[CONTRIBUTING.md](https://github.com/dirkdev98/maligator/blob/main/CONTRIBUTING.md) covers running the compiler from source, choosing focused verification, and the repository layout. [AGENTS.md](https://github.com/dirkdev98/maligator/blob/main/AGENTS.md) is the working policy for changes, and the [website build instructions](https://github.com/dirkdev98/maligator/blob/main/website/README.md) cover documentation sources, previews, and the container build.
