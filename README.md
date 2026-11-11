# Woxi Mobile

Android frontend for [Woxi](https://github.com/ad-si/Woxi) the Wolfram Language interpreter, with a mobile-friendly UI inspired by MathStudio.

## Build

```pwsh
# SDK and NDK (put them on PATH, or export `ANDROID_HOME` pointing at the SDK)
rustup target add aarch64-linux-android
cargo install cargo-ndk
sdkmanager "ndk;28.2.13676358"

# Engine (after changing `engine/`)
# For development use the profile `fast`, without LTO and without debug info, incremental. A rebuild takes seconds.
.\tools\build-engine.ps1 -Profile fast                # arm64-v8a
.\tools\build-engine.ps1 -Abi x86_64 -Profile fast    # x86_64 for emulator

# For release use the profile `release`, with thin LTO. A build takes minutes.
.\tools\build-engine.ps1                              # arm64-v8a

# App
# Gradle 9.9 runs on JDK 17-25. Point `JAVA_HOME` at one, or have `java` on PATH.
.\gradlew.bat :app:assembleRelease                    # arm64-v8a
.\gradlew.bat :app:assembleRelease -Pabi=all          # arm64-v8a + x86_64

# Build + install + launch + screenshot on a connected phone
.\tools\deploy.ps1
```

Notes:
- `cargo-ndk` needs an NDK. `tools/build-engine.ps1` uses `ANDROID_NDK_HOME` if set, otherwise the newest NDK under the SDK found through `ANDROID_HOME`, `ANDROID_SDK_ROOT` or Android Studio's default location.
- The library is stored uncompressed and mmapped from the APK. Only ABIs that have a `libwoxi_jni.so` in `app/src/main/jniLibs` are packaged, and `-Pabi` picks which. The default is arm64-v8a alone.

## Lint and test

```pwsh
cd engine
cargo fmt --check
cargo clippy --profile fast --all-targets -- -D warnings
# The tests share the interpreter's global session state, so they run on one thread.
cargo test --profile fast -- --test-threads=1
```

See `.github/workflows/lint.yml` for lints and tests other than Rust.

## Keeping rebuilds warm

Once the first `fast` build has populated `engine/target/fast`, a change to `engine/src` costs about two seconds: the wrapper crate recompiles and the test binary relinks. `cargo clippy` over the same tree is under a second, and `cargo fmt --check` is instant.

A four-minute rebuild means the interpreter itself is being compiled again, and that only happens when `woxi`, `engine/Cargo.toml` or `engine/Cargo.lock` changes, or when its artifacts under `engine/target/fast` are deleted. A commit does not: `woxi`'s build script asks cargo to watch `.git/HEAD` and the branch ref to stamp its own version, but it runs inside the registry copy of the crate, where no `.git` exists, so those watches are dropped (checked by touching both files: the wrapper rebuilt in two seconds, `woxi` stayed fresh). The NDK path is pinned by `tools/build-engine.ps1`, so the environment cargo records for build scripts is the same on every run. `target/fast/build/<crate>-<hash>/` holds what a build script generated; `woxi` generates its tables there, so removing that directory re-runs the script and recompiles `woxi` on the next build. Do not prune target subdirectories by hand: if space is needed, delete `engine/target/<profile>` as a whole and accept one cold build.

Clippy is a second graph (check-only units) next to the test build, so it type-checks every dependency once per change to one. Afterward it stays warm across edits of `engine/src`. `--no-deps` keeps the lints to this crate, which is what a plain run does anyway.

A probe workspace (a throwaway crate that depends on `woxi`, used to check what the interpreter does before writing engine code) keeps its own `target/` for the same reason. Cargo keys artifacts on the whole unit graph, so a workspace that differs by one crate version recompiles everything instead of reusing another workspace's artifacts. Copy `engine/Cargo.lock` into it when the app's lock changes, build it with `cargo run --profile fast --bin <probe>`, and an edit to a probe costs a second.

## Automation and debugging

See `docs/automation.md`.
