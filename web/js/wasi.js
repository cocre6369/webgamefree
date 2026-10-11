/**
 * wasi.js - a tiny WASI preview1 implementation for the browser.
 *
 * The DOOM engine is compiled for wasm32-wasi, so it expects a small set of
 * host calls: open/read/write/seek files, exit, random bytes, a clock, ...
 * Instead of shipping a full WASI runtime we implement exactly what the engine
 * needs on top of a virtual filesystem that lives in JavaScript memory.
 *
 * That buys us two nice things:
 *   - the Freedoom IWAD is handed over as an already-decompressed Uint8Array,
 *     so 27 MiB of game data never has to touch real storage, and
 *   - DOOM's config file and savegames are plain JS buffers, which the app
 *     persists to localStorage - save/load works, and survives a reload.
 *
 * The ABI (struct layouts, errno values, rights bits) follows
 * wasi_snapshot_preview1 as documented in the WASI specification.
 */

export const ERRNO = {
  SUCCESS: 0,
  ACCES: 2,
  BADF: 8,
  EXIST: 20,
  FAULT: 21,
  INVAL: 28,
  ISDIR: 31,
  NAMETOOLONG: 37,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTEMPTY: 55,
  PERM: 63,
  ROFS: 69,
};

export const FILETYPE = {
  UNKNOWN: 0,
  BLOCK_DEVICE: 1,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
};

export const OFLAGS = {
  CREAT: 1,
  DIRECTORY: 2,
  EXCL: 4,
  TRUNC: 8,
};

export const FDFLAGS = {
  APPEND: 1,
  DSYNC: 2,
  NONBLOCK: 4,
  RSYNC: 8,
  SYNC: 16,
};

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

const RIGHTS_ALL = 0xffffffffffffffffn;

/** A file in the virtual filesystem. */
class VFile {
  constructor(name, bytes = null) {
    this.name = name;
    this.bytes = bytes; // Uint8Array | null while empty
    this.used = bytes ? bytes.length : 0; // logical length; capacity can be larger
  }

  get size() {
    return this.used;
  }

  /** Make sure [0, newSize) is inside the backing store. */
  ensureCapacity(newSize) {
    if (newSize > this.used) this.used = newSize;
    if (this.bytes && this.bytes.length >= newSize) return;
    let capacity = this.bytes ? this.bytes.length : 0;
    while (capacity < newSize) capacity = Math.max(1024, capacity * 2);
    const next = new Uint8Array(capacity);
    if (this.bytes) next.set(this.bytes.subarray(0, Math.min(this.bytes.length, capacity)));
    this.bytes = next;
  }
}

/**
 * Virtual filesystem plus open file descriptor table.
 *
 * Paths live in one flat namespace ("freedoom1.wad", "default.cfg",
 * "doomsav0.dsg", ...).  Leading "/" and "./" are stripped when a path is
 * normalised, and lookups fall back to a basename match, because DOOM probes
 * for IWADs in a pile of different directories.
 */
export class VirtualFS {
  constructor() {
    this.files = new Map(); // path -> VFile
    this.fds = new Map(); // fd -> descriptor object
    this.nextFd = 4;
    this.baseTime = Date.now() * 1e6;
  }

  static normalise(path) {
    let p = String(path).replace(/\\/g, "/");
    for (;;) {
      if (p.startsWith("/")) p = p.slice(1);
      else if (p.startsWith("./")) p = p.slice(2);
      else if (p === ".") p = "";
      else break;
    }
    return p;
  }

  addFile(name, bytes) {
    const path = VirtualFS.normalise(name);
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const file = new VFile(path, data);
    this.files.set(path, file);
    return file;
  }

  get(path) {
    const p = VirtualFS.normalise(path);
    if (this.files.has(p)) return this.files.get(p);
    const base = p.split("/").pop();
    for (const [key, file] of this.files) {
      if (key === base || key.endsWith("/" + base)) return file;
    }
    return null;
  }

  exists(path) {
    return this.get(path) !== null;
  }

  remove(path) {
    const file = this.get(path);
    if (!file) return false;
    this.files.delete(file.name);
    return true;
  }

  /** Register the preopened root directory (WASI fd 3). */
  initDescriptors() {
    this.fds.set(0, { kind: "char", name: "stdin" });
    this.fds.set(1, { kind: "char", name: "stdout" });
    this.fds.set(2, { kind: "char", name: "stderr" });
    this.fds.set(3, { kind: "dir", path: "", preopen: true });
  }

  allocateFd(descriptor) {
    for (let attempt = 0; attempt < 256; attempt++) {
      const fd = this.nextFd++;
      if (this.nextFd > 4096) this.nextFd = 4;
      if (!this.fds.has(fd)) {
        this.fds.set(fd, descriptor);
        return fd;
      }
    }
    throw new Error("out of file descriptors");
  }

  listDir() {
    return [...this.files.keys()];
  }
}

/**
 * Build the WASI import object for a WebAssembly instance.
 *
 * @param {object} options
 * @param {() => WebAssembly.Memory} options.getMemory accessor (memory can grow)
 * @param {VirtualFS} [options.fs]
 * @param {string[]} [options.args]
 * @param {(text: string) => void} [options.onStdout]
 * @param {(text: string) => void} [options.onStderr]
 * @param {(code: number) => void} [options.onExit]
 */
export function createWasiImports(options) {
  const fs = options.fs || new VirtualFS();
  if (fs.fds.size === 0) fs.initDescriptors();

  const args = options.args || [];
  const onStdout = options.onStdout || (() => {});
  const onStderr = options.onStderr || (() => {});
  const onExit = options.onExit || (() => {});

  const memory = () => options.getMemory();
  const bytes = (ptr, len) => new Uint8Array(memory().buffer, ptr, len);
  const data = (ptr, len = 8) => new DataView(memory().buffer, ptr, len);

  const utf8 = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const argv = args.map((a) => a + "\0").join("");

  /** Encode a path that libc handed us (relative to the preopened root). */
  const pathOf = (ptr, len) => VirtualFS.normalise(decoder.decode(bytes(ptr, len)));

  const writeFileStat = (view, filetype, size) => {
    view.setBigUint64(0, 0n, true); // dev
    view.setBigUint64(8, 0n, true); // ino
    view.setUint8(16, filetype);
    view.setBigUint64(24, 1n, true); // nlink
    view.setBigUint64(32, BigInt(size), true);
    const now = BigInt(Date.now()) * 1000000n;
    view.setBigUint64(40, now, true);
    view.setBigUint64(48, now, true);
    view.setBigUint64(56, now, true);
  };

  const writeFdStat = (view, filetype, flags = 0) => {
    view.setUint8(0, filetype);
    view.setUint16(2, flags, true);
    view.setBigUint64(8, RIGHTS_ALL, true);
    view.setBigUint64(16, RIGHTS_ALL, true);
  };

  return {
    wasi_snapshot_preview1: {
      args_sizes_get(argcPtr, argvSizePtr) {
        data(argcPtr).setUint32(0, args.length, true);
        data(argvSizePtr).setUint32(0, argv.length, true);
        return ERRNO.SUCCESS;
      },

      args_get(argvPtr, argvBufPtr) {
        let offset = 0;
        for (let i = 0; i < args.length; i++) {
          data(argvPtr + i * 4).setUint32(0, argvBufPtr + offset, true);
          offset += args[i].length + 1;
        }
        bytes(argvBufPtr, argv.length).set(utf8.encode(argv));
        return ERRNO.SUCCESS;
      },

      environ_sizes_get(countPtr, sizePtr) {
        data(countPtr).setUint32(0, 0, true);
        data(sizePtr).setUint32(0, 0, true);
        return ERRNO.SUCCESS;
      },

      environ_get() {
        return ERRNO.SUCCESS;
      },

      clock_res_get(_clockId, resPtr) {
        data(resPtr, 8).setBigUint64(0, 1000000n, true);
        return ERRNO.SUCCESS;
      },

      clock_time_get(_clockId, _precision, timePtr) {
        data(timePtr, 8).setBigUint64(0, BigInt(Math.round(performance.now() * 1e6)), true);
        return ERRNO.SUCCESS;
      },

      random_get(bufPtr, bufLen) {
        const target = bytes(bufPtr, bufLen);
        const cryptoObj = globalThis.crypto;
        if (cryptoObj && cryptoObj.getRandomValues) {
          for (let i = 0; i < bufLen; i += 65536) {
            cryptoObj.getRandomValues(target.subarray(i, Math.min(bufLen, i + 65536)));
          }
        } else {
          for (let i = 0; i < bufLen; i++) target[i] = (Math.random() * 256) | 0;
        }
        return ERRNO.SUCCESS;
      },

      fd_write(fd, iovsPtr, iovsLen, writtenPtr) {
        const entry = fs.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        let written = 0;
        const text = [];
        for (let i = 0; i < iovsLen; i++) {
          const base = data(iovsPtr + i * 8).getUint32(0, true);
          const len = data(iovsPtr + i * 8 + 4).getUint32(0, true);
          if (len === 0) continue;
          const chunk = bytes(base, len);
          if (entry.kind === "file") {
            entry.file.ensureCapacity(entry.offset + len);
            entry.file.bytes.set(chunk, entry.offset);
            entry.offset += len;
          } else {
            text.push(decoder.decode(chunk));
          }
          written += len;
        }
        if (text.length) {
          if (fd === 2) onStderr(text.join(""));
          else onStdout(text.join(""));
        }
        data(writtenPtr).setUint32(0, written, true);
        return ERRNO.SUCCESS;
      },

      fd_read(fd, iovsPtr, iovsLen, readPtr) {
        const entry = fs.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        let read = 0;
        if (entry.kind === "file") {
          for (let i = 0; i < iovsLen; i++) {
            const base = data(iovsPtr + i * 8).getUint32(0, true);
            const len = data(iovsPtr + i * 8 + 4).getUint32(0, true);
            const available = Math.max(0, entry.file.size - entry.offset);
            const n = Math.min(len, available);
            if (n > 0) {
              bytes(base, n).set(entry.file.bytes.subarray(entry.offset, entry.offset + n));
              entry.offset += n;
              read += n;
            }
          }
        }
        data(readPtr).setUint32(0, read, true);
        return ERRNO.SUCCESS;
      },

      fd_seek(fd, offset, whence, newOffsetPtr) {
        const entry = fs.fds.get(fd);
        if (!entry || entry.kind !== "file") return ERRNO.BADF;
        const delta = Number(offset);
        let position;
        if (whence === SEEK_SET) position = delta;
        else if (whence === SEEK_CUR) position = entry.offset + delta;
        else if (whence === SEEK_END) position = entry.file.size + delta;
        else return ERRNO.INVAL;
        entry.offset = Math.max(0, position);
        data(newOffsetPtr, 8).setBigUint64(0, BigInt(entry.offset), true);
        return ERRNO.SUCCESS;
      },

      fd_tell(fd, offsetPtr) {
        const entry = fs.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        data(offsetPtr, 8).setBigUint64(0, BigInt(entry.offset || 0), true);
        return ERRNO.SUCCESS;
      },

      fd_close(fd) {
        if (fd <= 3) return ERRNO.SUCCESS;
        return fs.fds.delete(fd) ? ERRNO.SUCCESS : ERRNO.BADF;
      },

      fd_sync() {
        return ERRNO.SUCCESS;
      },

      fd_datasync() {
        return ERRNO.SUCCESS;
      },

      fd_fdstat_get(fd, statPtr) {
        const entry = fs.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        const view = data(statPtr, 24);
        if (entry.kind === "file") writeFdStat(view, FILETYPE.REGULAR_FILE);
        else if (entry.kind === "dir") writeFdStat(view, FILETYPE.DIRECTORY);
        else writeFdStat(view, FILETYPE.CHARACTER_DEVICE);
        return ERRNO.SUCCESS;
      },

      fd_fdstat_set_flags(fd, flags) {
        const entry = fs.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        entry.fdflags = flags;
        return ERRNO.SUCCESS;
      },

      fd_filestat_get(fd, statPtr) {
        const entry = fs.fds.get(fd);
        if (!entry) return ERRNO.BADF;
        if (entry.kind === "file") writeFileStat(data(statPtr, 64), FILETYPE.REGULAR_FILE, entry.file.size);
        else if (entry.kind === "dir") writeFileStat(data(statPtr, 64), FILETYPE.DIRECTORY, 0);
        else writeFileStat(data(statPtr, 64), FILETYPE.CHARACTER_DEVICE, 0);
        return ERRNO.SUCCESS;
      },

      fd_filestat_set_size(fd, size) {
        const entry = fs.fds.get(fd);
        if (!entry || entry.kind !== "file") return ERRNO.BADF;
        entry.file.ensureCapacity(Number(size));
        return ERRNO.SUCCESS;
      },

      fd_prestat_get(fd, prestatPtr) {
        const entry = fs.fds.get(fd);
        if (!entry || !entry.preopen) return ERRNO.BADF;
        const view = data(prestatPtr, 8);
        view.setUint8(0, 0); // preopentype::dir
        view.setUint32(4, 1, true); // name length, "/"
        return ERRNO.SUCCESS;
      },

      fd_prestat_dir_name(fd, pathPtr, pathLen) {
        const entry = fs.fds.get(fd);
        if (!entry || !entry.preopen) return ERRNO.BADF;
        if (pathLen < 1) return ERRNO.NAMETOOLONG;
        bytes(pathPtr, 1).set(utf8.encode("/"));
        return ERRNO.SUCCESS;
      },

      fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
        const entry = fs.fds.get(fd);
        if (!entry || entry.kind !== "dir") return ERRNO.BADF;
        const names = fs.listDir();
        const view = new DataView(memory().buffer);
        let used = 0;
        for (let i = Number(cookie); i < names.length && used < bufLen; i++) {
          const name = utf8.encode(names[i]);
          const direntSize = 24;
          if (used + direntSize + name.length > bufLen) break;
          const base = bufPtr + used;
          view.setBigUint64(base, BigInt(i + 1), true);
          view.setBigUint64(base + 8, BigInt(i + 1), true);
          view.setUint32(base + 16, name.length, true);
          view.setUint8(base + 20, FILETYPE.REGULAR_FILE);
          new Uint8Array(memory().buffer, base + 24, name.length).set(name);
          used += direntSize + name.length;
        }
        data(usedPtr).setUint32(0, used, true);
        return ERRNO.SUCCESS;
      },

      path_open(_dirFd, _dirFlags, pathPtr, pathLen, oflags, _rightsBase, _rightsInheriting, fdflags, openedFdPtr) {
        const path = pathOf(pathPtr, pathLen);
        const wantsDirectory = (oflags & OFLAGS.DIRECTORY) !== 0;
        if (path === "" || wantsDirectory) {
          // The preopened root (and "." lookups) - hand back a fresh dir fd.
          const fd = fs.allocateFd({ kind: "dir", path: "" });
          data(openedFdPtr).setUint32(0, fd, true);
          return ERRNO.SUCCESS;
        }
        let file = fs.get(path);
        if (!file) {
          if ((oflags & OFLAGS.CREAT) === 0) return ERRNO.NOENT;
          file = new VFile(path, null);
          fs.files.set(path, file);
        } else if ((oflags & OFLAGS.TRUNC) !== 0) {
          file.bytes = new Uint8Array(0);
          file.used = 0;
        }
        const fd = fs.allocateFd({
          kind: "file",
          file,
          offset: (fdflags & FDFLAGS.APPEND) !== 0 ? file.size : 0,
        });
        data(openedFdPtr).setUint32(0, fd, true);
        return ERRNO.SUCCESS;
      },

      path_filestat_get(_fd, _flags, pathPtr, pathLen, statPtr, _statLen) {
        const path = pathOf(pathPtr, pathLen);
        const file = fs.get(path);
        if (!file) return ERRNO.NOENT;
        writeFileStat(data(statPtr, 64), FILETYPE.REGULAR_FILE, file.size);
        return ERRNO.SUCCESS;
      },

      path_create_directory() {
        return ERRNO.PERM;
      },

      path_remove_directory() {
        return ERRNO.PERM;
      },

      path_rename(_fd, oldPtr, oldLen, _newFd, newPtr, newLen) {
        const file = fs.get(decoder.decode(bytes(oldPtr, oldLen)));
        if (!file) return ERRNO.NOENT;
        fs.files.delete(file.name);
        file.name = pathOf(newPtr, newLen);
        fs.files.set(file.name, file);
        return ERRNO.SUCCESS;
      },

      path_unlink_file(_fd, pathPtr, pathLen) {
        return fs.remove(decoder.decode(bytes(pathPtr, pathLen))) ? ERRNO.SUCCESS : ERRNO.NOENT;
      },

      path_symlink() {
        return ERRNO.PERM;
      },

      path_link() {
        return ERRNO.PERM;
      },

      path_readlink() {
        return ERRNO.INVAL;
      },

      proc_exit(code) {
        onExit(code);
        throw new WebAssembly.RuntimeError(`proc_exit(${code})`);
      },

      poll_oneoff() {
        return ERRNO.NOSYS;
      },

      sched_yield() {
        return ERRNO.SUCCESS;
      },
    },
  };
}

export { SEEK_SET, SEEK_CUR, SEEK_END };
