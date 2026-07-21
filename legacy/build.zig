//! This build belongs to your app, written once by `native eject`:
//! the `native` CLI stops generating a build graph and drives this file
//! through `zig build` instead, and it will never rewrite it. `addApp`
//! wires the complete standard app build — executable, `zig build run`,
//! `zig build test`, and the -Dplatform/-Dweb-engine/-Dautomation/
//! -Doptimize flags — from the framework's build/app.zig, so a framework
//! upgrade still upgrades your build.
//!
//! This app's one extension: it owns its wiring (`src/wiring.zig`) so the
//! view can be real component files with real `<import>` elements. The
//! SDK's generated TypeScript-core wiring does not declare the markup
//! import closure (`MarkupOptions.sources`), so imports fail at runtime;
//! ours declares it.
//!
//! Passing a custom `.main` makes `addApp` skip core detection ("builds
//! with a custom `main` entry declared their core explicitly"), which is
//! what lets `src/core.ts` and a Zig wiring coexist. In exchange this
//! build owns the two things the TS path would have done for us:
//! transpiling the core, and importing app.zon into the wiring.

const std = @import("std");
const native_sdk = @import("native_sdk");

pub fn build(b: *std.Build) void {
    const dep = b.dependency("native_sdk", .{});

    const artifacts = native_sdk.addAppArtifacts(b, dep, .{
        .name = "artemis",
        .main = "src/wiring.zig",
    });

    const core_mod = tsCoreModule(b, dep);
    for ([_]*std.Build.Step.Compile{ artifacts.exe, artifacts.tests }) |compile| {
        compile.root_module.addImport("core", core_mod);
        // The wiring reads app.zon for scene/identity/security. Reuse the
        // module the SDK already built for `runner` — one file may belong
        // to only one module, so creating a second here is a hard error.
        const runner_mod = compile.root_module.import_table.get("runner").?;
        compile.root_module.addImport(
            "app_manifest_zon",
            runner_mod.import_table.get("app_manifest_zon").?,
        );
    }
}

/// Transpile `src/core.ts` to Zig and expose it as the `core` module.
/// Mirrors the SDK's own TS-core stage: the emitted core imports its rt
/// kernel relatively, so both are staged into one directory. Node is
/// already a build requirement (the transpiler runs on it).
fn tsCoreModule(b: *std.Build, dep: *std.Build.Dependency) *std.Build.Module {
    const node = b.findProgram(&.{"node"}, &.{}) catch @panic(
        "\nbuilding this app's TypeScript core needs node on PATH" ++
            " (the @native-sdk/core transpiler runs at build time;" ++
            " the binary it emits ships no JS runtime).\n",
    );

    // The transpiler runs through build/ts_run.mjs rather than `node
    // cli.ts`: on the npm-installed layout its sources live inside
    // node_modules, where node refuses builtin type stripping.
    const transpile = b.addSystemCommand(&.{node});
    transpile.addFileArg(dep.path("build/ts_run.mjs"));
    transpile.addFileArg(dep.path("packages/core/src/cli.ts"));
    transpile.addFileArg(b.path("src/core.ts"));
    transpile.addArg("-o");
    const emitted_core = transpile.addOutputFileArg("core.zig");

    // Declare the core's whole module graph as inputs so an edit to any
    // src/*.ts re-emits (an over-approximation only re-runs the
    // transpile; it never misses a stale input).
    addTsInputs(b, transpile, "src");

    const staged = b.addWriteFiles();
    const core_root = staged.addCopyFile(emitted_core, "core.zig");
    _ = staged.addCopyFile(dep.path("packages/core/rt/rt.zig"), "rt.zig");
    return b.createModule(.{ .root_source_file = core_root });
}

/// Declare every .ts file under `dir` (recursively) as a transpile input.
fn addTsInputs(b: *std.Build, step: *std.Build.Step.Run, dir_path: []const u8) void {
    var dir = b.build_root.handle.openDir(b.graph.io, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(b.graph.io);
    var it = dir.iterate();
    while (it.next(b.graph.io) catch null) |entry| {
        if (entry.kind == .directory) {
            addTsInputs(b, step, b.fmt("{s}/{s}", .{ dir_path, entry.name }));
            continue;
        }
        if (entry.kind != .file) continue;
        if (!std.mem.endsWith(u8, entry.name, ".ts")) continue;
        step.addFileInput(b.path(b.fmt("{s}/{s}", .{ dir_path, entry.name })));
    }
}
