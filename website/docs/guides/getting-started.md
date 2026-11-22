Install the CLI, initialize a project, and run its entry point. The npm launcher needs Node.js 20 or newer. The installed native CLI and the executables it produces do not need Node.js.

Prebuilt packages cover macOS 15 or newer and glibc-based Linux on arm64 and x64.

## Install the CLI

```shell
npm install --global @maligator/cli@alpha
maligator --version
mkdir hello-maligator
cd hello-maligator
maligator init
```

`init` uses the first entry it finds in `src/index.ts`, `src/main.ts`, `index.ts`, or `main.ts`. If it finds none, it writes a starter to `src/index.ts`. It keeps existing entry files and build configs, reports the paths it created or updated, and prints commands to run, watch, and test the project.

`init` adds `"type": "module"` to `package.json` when the field is missing and adds `@maligator/cli` to the TypeScript config's `compilerOptions.types`. It creates either file if needed. Use a project-local CLI installation to resolve the package declarations in your editor.

For a project-local installation, use `npm install --save-dev @maligator/cli@alpha` and prefix the commands below with `npx`.

## Run an entry point

```shell
maligator run src/index.ts
```

The starter prints `Hello, Maligator`. By default, `run` leaves stdout for the program's output. Edit `src/index.ts` to change it, or omit the path to use the entry from the build config. The npm package can run projects with the default configuration without a local toolchain.

Run commands from this directory. Entries and config paths resolve from the working directory; Maligator does not look for configuration in parent directories.

## Build a native executable

```shell
maligator doctor --verbose
maligator build --production
```

`doctor` reports the production compiler or the Zig download it plans to use. See [Set up native builds](/guides/native-toolchain) for toolchain selection and when to install local tools. A successful build prints the executable path. Launch that path directly.

If `run` reports a missing entry, check `entry` in `maligator.build.ts` or pass it explicitly: `maligator run src/index.ts`.

Continue with [Develop an application](/guides/development), or use the [CLI reference](/api/cli) to look up a command.
