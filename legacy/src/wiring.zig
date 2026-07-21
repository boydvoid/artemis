//! This app's wiring — our copy of the SDK's generated
//! `ts_core_main.zig`, owned here for exactly one reason: to declare the
//! markup import closure (`MarkupOptions.sources`) that the generated
//! wiring does not pass. That is what lets the view be real component
//! files (`src/view.native` + `src/components/*.native`) with real
//! `<import>` elements, instead of a generated flat `app.native`.
//!
//! build.zig hands this file to `addApp` as a custom `.main`, which makes
//! the build skip core detection (see build/app.zig: "builds with a
//! custom `main` entry declared their core explicitly"), so `src/core.ts`
//! and this Zig wiring coexist. build.zig transpiles the core itself and
//! passes it in as the `core` module.
//!
//! Keep in sync with the SDK's ts_core_main.zig on toolkit upgrades; the
//! only deltas are marked ARTEMIS below.

const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const manifest = @import("app_manifest_zon");
// ARTEMIS: the transpiled core is a build module (build.zig stages
// core.zig beside its rt kernel and wires it in), not a sibling file.
pub const core = @import("core");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

/// Re-exported so the model-contract step (and any test) reflects the
/// core's real surface: `native check` verifies app.native against it.
pub const Model = core.Model;
pub const Msg = core.Msg;

const Adapter = native_sdk.TsUiApp(core);
const App = Adapter.App;

const shell_scene = native_sdk.app_manifest.shellConfigFrom(manifest);
const canvas_label = native_sdk.app_manifest.firstGpuSurfaceLabel(shell_scene);
// ARTEMIS: the authored view root and its <import> closure. Paths are
// markup-root relative (the root file resolves as ""), so they match the
//  values in view.native exactly. Add a component file here when
// you add one to src/components/ —  fails loudly if the
// closure is incomplete.
pub const app_markup = @embedFile("view.native");
const markup_sources = [_]native_sdk.canvas.ui_markup.SourceFile{
    .{ .path = "components/header-cell.native", .source = @embedFile("components/header-cell.native") },
    .{ .path = "components/data-cell.native", .source = @embedFile("components/data-cell.native") },
    .{ .path = "components/staged-cell.native", .source = @embedFile("components/staged-cell.native") },
};

const app_permissions = manifestStringList(manifest, "permissions");
const allowed_origins = manifestAllowedOrigins();

pub fn main(init: std.process.Init) !void {
    var options: Adapter.Options = .{
        .name = manifest.name,
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .markup = .{
            .source = app_markup,
            // ARTEMIS: without this the import closure resolves against
            // an empty source set and every frame fails MarkupImport.
            .sources = &markup_sources,
            .watch_path = "src/view.native",
            .io = init.io,
        },
        // app.zon's theme pack; unthemed manifests get the house register.
        // The stock tokens compose the pack with the LIVE system
        // appearance, so TS apps follow the OS light/dark flip with no
        // core code. `theme_accent` is the manifest's one-accent brand
        // override, layered over the pack by the runtime (skipped under
        // high contrast — accessibility beats brand).
        .theme = comptime runner.manifestThemePack(),
        .theme_accent = comptime runner.manifestThemeAccent(),
    };
    if (comptime @hasDecl(core, "commandMsg")) {
        // Menus, shortcuts, and chrome tabs dispatch through the core's
        // exported command mapper.
        options.on_command = core.commandMsg;
    }
    // The platform caches directory for this app: when the core's
    // `Cmd.audioPlay` names a URL with no cachePath, the bridge derives
    // the conventional content-addressed path under this directory —
    // resolved once at launch (never inside update), so replay's
    // deterministic-init contract holds. Resolution failure just disables
    // the cache: streams still play, they re-download.
    var cache_dir_buffer: [512]u8 = undefined;
    const audio_cache_dir = native_sdk.app_dirs.resolveOne(
        .{ .name = manifest.name },
        native_sdk.app_dirs.currentPlatform(),
        native_sdk.debug.envFromMap(init.environ_map),
        .cache,
        &cache_dir_buffer,
    ) catch "";
    // app.zon-declared images, read once at launch (bounded; a missing or
    // over-bound file skips its entry and the views keep their fallback)
    // and registered by the adapter on the installing frame.
    const manifest_images = comptime manifestImages();
    var boot_images_buffer: [manifest_images.len]Adapter.BootImage = undefined;
    var boot_image_count: usize = 0;
    inline for (manifest_images) |asset| {
        if (std.Io.Dir.cwd().readFileAlloc(init.io, asset.path, std.heap.page_allocator, .limited(max_boot_image_bytes))) |bytes| {
            boot_images_buffer[boot_image_count] = .{ .id = asset.id, .bytes = bytes };
            boot_image_count += 1;
        } else |_| {}
    }

    // The core's launch-time environment channel (`envMsgs`): read each
    // named variable once, here at the boundary — never inside update —
    // and hand the present values to the adapter, which dispatches them
    // as ordinary journaled Msgs right after the boot command.
    var env_values_buffer: [envMsgsLen()]Adapter.EnvValue = undefined;
    var env_value_count: usize = 0;
    if (comptime @hasDecl(core, "envMsgs")) {
        inline for (core.envMsgs) |entry| {
            if (init.environ_map.get(entry.env)) |value| {
                env_values_buffer[env_value_count] = .{ .msg = entry.msg, .value = value };
                env_value_count += 1;
            }
        }
    }

    // The app struct (and any real model) is multi-MB: `create`
    // heap-allocates and constructs in place, so neither rides the stack.
    const app_state = try Adapter.create(std.heap.page_allocator, .{
        .audio_cache_dir = audio_cache_dir,
        .boot_images = boot_images_buffer[0..boot_image_count],
        .env_values = env_values_buffer[0..env_value_count],
    }, options);
    defer app_state.destroy();

    try runner.runWithOptions(app_state.app(), .{
        .app_name = manifest.name,
        .window_title = comptime windowTitle(),
        .bundle_id = manifest.id,
        .icon_path = "assets/icon.png",
        .default_frame = comptime defaultFrame(),
        .restore_state = comptime startupRestoreState(),
        .js_window_api = false,
        .security = .{
            .permissions = app_permissions,
            .navigation = .{ .allowed_origins = allowed_origins },
        },
    }, init);
}

/// The startup window title: the scene's first window title, else the
/// manifest display name, else the app name.
fn windowTitle() []const u8 {
    if (shell_scene.windows.len > 0) {
        if (shell_scene.windows[0].title) |title| return title;
    }
    if (@hasField(@TypeOf(manifest), "display_name")) return manifest.display_name;
    return manifest.name;
}

fn defaultFrame() native_sdk.geometry.RectF {
    if (shell_scene.windows.len > 0) {
        const window = shell_scene.windows[0];
        return native_sdk.geometry.RectF.init(window.x orelse 0, window.y orelse 0, window.width, window.height);
    }
    return native_sdk.geometry.RectF.init(0, 0, 720, 480);
}

fn startupRestoreState() bool {
    if (shell_scene.windows.len > 0) return shell_scene.windows[0].restore_state;
    return true;
}

/// One app.zon `.assets.images` entry: the encoded file the wiring reads
/// at launch and the `ImageId` markup avatar bindings reference.
const ImageAsset = struct {
    id: u64,
    path: []const u8,
};

/// Encoded-size bound for one boot image: over-bound files skip their
/// entry (the views keep the initials fallback) instead of holding the
/// launch path hostage to a mis-sized asset.
const max_boot_image_bytes: usize = 4 * 1024 * 1024;

fn manifestImages() []const ImageAsset {
    comptime {
        if (!@hasField(@TypeOf(manifest), "assets")) return &.{};
        if (!@hasField(@TypeOf(manifest.assets), "images")) return &.{};
        var out: []const ImageAsset = &.{};
        for (manifest.assets.images) |entry| {
            out = out ++ &[_]ImageAsset{.{ .id = entry.id, .path = entry.path }};
        }
        return out;
    }
}

fn envMsgsLen() usize {
    comptime {
        if (!@hasDecl(core, "envMsgs")) return 0;
        return core.envMsgs.len;
    }
}

fn manifestStringList(comptime m: anytype, comptime field: []const u8) []const []const u8 {
    comptime {
        if (!@hasField(@TypeOf(m), field)) return &.{};
        var out: []const []const u8 = &.{};
        for (@field(m, field)) |entry| {
            const name: []const u8 = entry;
            out = out ++ &[_][]const u8{name};
        }
        return out;
    }
}

fn manifestAllowedOrigins() []const []const u8 {
    comptime {
        if (!@hasField(@TypeOf(manifest), "security")) return &.{};
        if (!@hasField(@TypeOf(manifest.security), "navigation")) return &.{};
        return manifestStringList(manifest.security.navigation, "allowed_origins");
    }
}
