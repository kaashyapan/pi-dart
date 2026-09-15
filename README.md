# dart Pi extension

For Dart and Flutter projects

Wraps `dart analyze`, `dart test`, `dart fix`, and `dart run build_runner build` as discrete
Pi tools with summarized, token-efficient output — so the model gets a compact diagnostics
list instead of raw compiler/test/build-log text.

Dart SDK version: 3.13.2 (stable)

## Install

```
pi install npm:pi-dart
```

## Commands

Check tool health

```
/dart-doctor
```

## Tools registered

- `dart_analyze` — Diagnostics parsed and summarized by file/severity
- `dart_test` — Test results, summarized to pass/fail counts + failure details
- `dart_fix` — Preview/apply automated analyzer fixes (dry-run by default)
- `build_runner` — Build runner, log-filtered to warnings/errors + summary line

## Agent instructions

1. Edit .dart source file
2. `dart_analyze` with a low `diagnosticLimit` first (cheap first-error check)
3. `dart_analyze` full pass
4. `dart_test` (once analyze is clean)
5. `dart_fix` dry-run — review before `apply: true`
6. `build_runner` if the project uses code generation and generated files are stale
