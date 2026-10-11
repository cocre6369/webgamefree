/**
 * savedata.js - keep DOOM's files across reloads.
 *
 * The WASI layer in wasi.js keeps its filesystem in JavaScript memory, so
 * default.cfg (settings) and doomsav*.dsg (savegames) are just Uint8Arrays.
 * This module mirrors the interesting ones into localStorage and pushes them
 * back into the engine when the game starts, which is what makes DOOM's own
 * "save game" menu work on the web.
 */

const PREFIX = "freedoom-wasm:";
const INTERESTING = [/^default\.cfg$/, /^doom\.cfg$/, /^doomsav\d+\.dsg$/, /^\.?default\.cfg$/, /\.dsg$/];

function isInteresting(name) {
  return INTERESTING.some((pattern) => pattern.test(name));
}

function toBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class SaveStore {
  constructor(fs, { onSave = null } = {}) {
    this.fs = fs;
    this.onSave = onSave;
    this.timer = null;
    this.lastFingerprint = "";
  }

  /** Put previously stored files back into the engine's filesystem. */
  restore() {
    let restored = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      const name = key.slice(PREFIX.length);
      try {
        const bytes = fromBase64(localStorage.getItem(key));
        if (bytes.length > 0) {
          this.fs.addFile(name, bytes);
          restored++;
        }
      } catch (error) {
        console.warn("could not restore", name, error);
      }
    }
    return restored;
  }

  /** Snapshot the engine's files into localStorage (debounced). */
  saveNow() {
    let saved = 0;
    for (const [name, file] of this.fs.files) {
      if (!isInteresting(name) || file.size === 0) continue;
      try {
        localStorage.setItem(PREFIX + name, toBase64(file.bytes.subarray(0, file.size)));
        saved++;
      } catch (error) {
        console.warn("could not store", name, error);
        return saved;
      }
    }
    if (saved > 0) this.onSave?.(saved);
    return saved;
  }

  /**
   * Watch the filesystem for changes.  DOOM writes the config on exit and
   * savegames when the player saves, so a periodic fingerprint check is the
   * simplest reliable trigger.
   */
  watch(intervalMs = 3000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const fingerprint = [...this.fs.files.entries()]
        .filter(([name]) => isInteresting(name))
        .map(([name, file]) => `${name}:${file.size}`)
        .sort()
        .join("|");
      if (fingerprint !== this.lastFingerprint) {
        this.lastFingerprint = fingerprint;
        this.saveNow();
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Forget everything (used by "restart with a clean slate"). */
  clear() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    return keys.length;
  }

  list() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) out.push({ name: key.slice(PREFIX.length), bytes: localStorage.getItem(key)?.length ?? 0 });
    }
    return out;
  }
}
