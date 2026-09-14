//! §08.3.3 — the Node-API addon that replaces a shim with its tool.
//!
//! One function, `execve(block, argc, envc, keepFd)`, which returns an errno
//! and only when the call failed. It exists for two things `process.execve`
//! cannot do: hand a descriptor Node marked close-on-exec at startup through
//! to the tool (the caller's IPC channel), and *fail* — Node's aborts the whole
//! process on any `execve` the kernel refuses.
//!
//! `block` holds every string NUL-terminated — path, then `argc` arguments,
//! then `envc` `KEY=value` entries — followed by room the JavaScript side
//! reserves for the two pointer arrays, which are built in place so nothing
//! here allocates. No libc on Linux (raw system calls), so one file per
//! architecture serves glibc and musl alike; elsewhere the three C functions
//! bind to the host process's libc at load time.
//!
//! Built by `scripts/build-addon.mjs`, which embeds the output in
//! `src/run/addon-binaries.ts`.

const builtin = @import("builtin");
const linux = if (builtin.os.tag == .linux) @import("std").os.linux else struct {};

const Env = *opaque {};
const Value = *opaque {};
const CallbackInfo = *opaque {};
const Callback = *const fn (Env, CallbackInfo) callconv(.c) ?Value;

extern fn napi_create_function(Env, [*:0]const u8, usize, Callback, ?*anyopaque, *Value) c_int;
extern fn napi_create_int32(Env, i32, *Value) c_int;
extern fn napi_set_named_property(Env, Value, [*:0]const u8, Value) c_int;
extern fn napi_get_cb_info(Env, CallbackInfo, *usize, [*]?Value, ?*Value, ?*?*anyopaque) c_int;
extern fn napi_get_buffer_info(Env, Value, *?[*]u8, *usize) c_int;
extern fn napi_get_value_int32(Env, Value, *i32) c_int;

/// Bumped whenever `execve`'s contract changes, so a stale extracted file is
/// refused rather than called wrongly.
const ABI = 1;

const F_GETFD = 1;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
const EINVAL = 22;

const c = struct {
    extern "c" fn fcntl(fd: c_int, cmd: c_int, ...) c_int;
    extern "c" fn execve(path: [*:0]const u8, argv: [*]const ?[*:0]const u8, envp: [*]const ?[*:0]const u8) c_int;
    extern "c" fn __error() *c_int;
};

/// The descriptor flags, or a negative errno.
fn getFd(fd: i32) i32 {
    if (builtin.os.tag == .linux) {
        const rc: isize = @bitCast(linux.fcntl(fd, F_GETFD, 0));
        return @intCast(rc);
    }
    const rc = c.fcntl(fd, F_GETFD, @as(c_int, 0));
    return if (rc < 0) -c.__error().* else rc;
}

fn setFd(fd: i32, flags: i32) void {
    if (builtin.os.tag == .linux) {
        _ = linux.fcntl(fd, F_SETFD, @as(usize, @intCast(flags)));
    } else {
        _ = c.fcntl(fd, F_SETFD, @as(c_int, flags));
    }
}

/// Returns only on failure, with the errno.
fn exec(path: [*:0]const u8, argv: [*]const ?[*:0]const u8, envp: [*]const ?[*:0]const u8) i32 {
    if (builtin.os.tag == .linux) {
        const rc: isize = @bitCast(linux.execve(path, @ptrCast(argv), @ptrCast(envp)));
        return @intCast(-rc);
    }
    _ = c.execve(path, argv, envp);
    return c.__error().*;
}

fn replace(env: Env, info: CallbackInfo) i32 {
    var argc: usize = 4;
    var args: [4]?Value = .{ null, null, null, null };
    if (napi_get_cb_info(env, info, &argc, &args, null, null) != 0 or argc < 4) return EINVAL;

    var data: ?[*]u8 = null;
    var length: usize = 0;
    var counts: [3]i32 = undefined;
    if (napi_get_buffer_info(env, args[0].?, &data, &length) != 0 or data == null) return EINVAL;
    for (&counts, args[1..4]) |*count, arg| {
        if (napi_get_value_int32(env, arg.?, count) != 0) return EINVAL;
    }
    if (counts[0] < 1 or counts[1] < 0) return EINVAL;
    // In `usize`: two counts near `maxInt(i32)` would overflow an `i32` sum.
    const strings: usize = 1 + @as(usize, @intCast(counts[0])) + @as(usize, @intCast(counts[1]));
    const keep_fd = counts[2];

    // Find where each string starts; the NUL after the last one ends the text.
    const bytes = data.?[0..length];
    const word: usize = @sizeOf(usize);
    var slots_at: usize = 0;
    {
        var seen: usize = 0;
        while (seen < strings) : (slots_at += 1) {
            if (slots_at >= length) return EINVAL;
            if (bytes[slots_at] == 0) seen += 1;
        }
    }
    // The pointer arrays go after the text, word-aligned: `strings` pointers
    // plus two terminators, less the path's own slot.
    const base = @intFromPtr(data.?);
    const aligned = (base + slots_at + word - 1) & ~(word - 1);
    const needed = (strings + 1) * word;
    if (aligned - base + needed > length) return EINVAL;
    const slots: [*]?[*:0]const u8 = @ptrFromInt(aligned);

    var at: usize = 0;
    var index: usize = 0;
    while (index < strings) : (index += 1) {
        const start: [*:0]const u8 = @ptrCast(data.? + at);
        // Slot 0 would be the path; argv starts at 1, env after argv's NULL.
        if (index > 0) slots[if (index <= counts[0]) index - 1 else index] = start;
        while (bytes[at] != 0) at += 1;
        at += 1;
    }
    const argv_len: usize = @intCast(counts[0]);
    slots[argv_len] = null;
    slots[strings] = null;
    const path: [*:0]const u8 = @ptrCast(data.?);

    // As Node's own `process.execve` does for 0–2, and the caller's channel.
    var fds: [4]i32 = .{ 0, 1, 2, keep_fd };
    var saved: [4]i32 = .{ -1, -1, -1, -1 };
    const fd_count: usize = if (keep_fd > 2) 4 else 3;
    for (fds[0..fd_count], saved[0..fd_count]) |fd, *flags| {
        const current = getFd(fd);
        if (current < 0) continue;
        flags.* = current;
        if (current & FD_CLOEXEC != 0) setFd(fd, current & ~@as(i32, FD_CLOEXEC));
    }

    const errno = exec(path, slots, slots + argv_len + 1);

    for (fds[0..fd_count], saved[0..fd_count]) |fd, flags| {
        if (flags >= 0 and flags & FD_CLOEXEC != 0) setFd(fd, flags);
    }
    return if (errno == 0) EINVAL else errno;
}

fn execveCallback(env: Env, info: CallbackInfo) callconv(.c) ?Value {
    var result: Value = undefined;
    return if (napi_create_int32(env, replace(env, info), &result) == 0) result else null;
}

export fn napi_register_module_v1(env: Env, exports: Value) Value {
    var function: Value = undefined;
    if (napi_create_function(env, "execve", 6, execveCallback, null, &function) == 0) {
        _ = napi_set_named_property(env, exports, "execve", function);
    }
    var abi: Value = undefined;
    if (napi_create_int32(env, ABI, &abi) == 0) {
        _ = napi_set_named_property(env, exports, "abi", abi);
    }
    return exports;
}

export fn node_api_module_get_api_version_v1() i32 {
    return 1;
}
