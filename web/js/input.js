/**
 * input.js - keyboard, mouse and touch -> DOOM key codes.
 *
 * DOOM was written for a DOS keyboard, so "keys" are the codes in
 * doomkeys.h (arrow keys, KEY_FIRE, 'a'...'z', function keys).  The browser
 * gives us KeyboardEvent.code, so the mapping below translates one into the
 * other.
 *
 * Mouse support is emulated on top of the same key interface: the engine has
 * no notion of a mouse in this port, so horizontal movement is turned into
 * momentary left/right arrow presses (a "mouse to arrow keys" steerer, see
 * MouseTurner).  This keeps the engine source completely untouched.
 */

import { DOOM_KEY } from "./doom.js";

/** KeyboardEvent.code -> DOOM key code. */
const KEY_MAP = {
  ArrowLeft: DOOM_KEY.LEFTARROW,
  ArrowRight: DOOM_KEY.RIGHTARROW,
  ArrowUp: DOOM_KEY.UPARROW,
  ArrowDown: DOOM_KEY.DOWNARROW,

  ControlLeft: DOOM_KEY.FIRE,
  ControlRight: DOOM_KEY.FIRE,
  Space: DOOM_KEY.USE,

  ShiftLeft: DOOM_KEY.RSHIFT,
  ShiftRight: DOOM_KEY.RSHIFT,
  AltLeft: DOOM_KEY.LALT,
  AltRight: DOOM_KEY.LALT,

  Enter: DOOM_KEY.ENTER,
  NumpadEnter: DOOM_KEY.ENTER,
  Escape: DOOM_KEY.ESCAPE,
  Tab: DOOM_KEY.TAB,
  Backspace: DOOM_KEY.BACKSPACE,
  Minus: DOOM_KEY.MINUS,
  Equal: DOOM_KEY.EQUALS,
  NumpadAdd: DOOM_KEY.EQUALS,
  NumpadSubtract: DOOM_KEY.MINUS,
  Pause: DOOM_KEY.PAUSE,

  Comma: ",".charCodeAt(0),
  Period: ".".charCodeAt(0),
  Slash: "/".charCodeAt(0),
  Quote: "'".charCodeAt(0),
  Semicolon: ";".charCodeAt(0),
  BracketLeft: "[".charCodeAt(0),
  BracketRight: "]".charCodeAt(0),
  Backquote: "`".charCodeAt(0),
  NumpadDivide: "/".charCodeAt(0),
  NumpadMultiply: "*".charCodeAt(0),

  F1: DOOM_KEY.F1,
  F2: DOOM_KEY.F2,
  F3: DOOM_KEY.F3,
  F4: DOOM_KEY.F4,
  F5: DOOM_KEY.F5,
  F6: DOOM_KEY.F6,
  F7: DOOM_KEY.F7,
  F8: DOOM_KEY.F8,
  F9: DOOM_KEY.F9,
  F10: DOOM_KEY.F10,
  F11: DOOM_KEY.F11,
  F12: DOOM_KEY.F12,
};

/** Keys this app handles itself instead of forwarding to the game. */
export const APP_KEYS = {
  KeyF: "fullscreen",
  KeyM: "music",
  KeyS: "sfx",
  KeyH: "help",
  KeyR: "restart",
  F11: "fullscreen",
};

export function toDoomKey(event) {
  const { code, key, keyCode } = event;

  if (KEY_MAP[code] !== undefined) return KEY_MAP[code];

  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3); // 'A'..'Z'
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5); // '0'..'9'
  if (/^Numpad[0-9]$/.test(code)) return code.charCodeAt(6);
  if (/^F[0-9]{1,2}$/.test(code) && Number(code.slice(1)) >= 1 && Number(code.slice(1)) <= 12) {
    return 0x80 + 0x3a + Number(code.slice(1)); // not exact, but unused
  }

  if (keyCode >= 65 && keyCode <= 90) return keyCode; // upper case letters
  if (key && key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return upper.charCodeAt(0);
    return key.charCodeAt(0);
  }
  return 0;
}

/** Bind the physical keyboard to a DOOM instance. */
export function attachKeyboard(doom, { onAppKey, isEnabled } = {}) {
  const pressed = new Set();

  const down = (event) => {
    const appKey = APP_KEYS[event.code];
    if (appKey && onAppKey) {
      // Alt/Ctrl combinations belong to the game, plain letters to the app.
      if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        onAppKey(appKey, event.code);
        event.preventDefault();
        return;
      }
    }

    // The browser eats Tab, F-keys, arrows and space when something is
    // focused - keep them inside the game.
    if (event.code.startsWith("F") || ["Tab", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      event.preventDefault();
    }

    if (isEnabled && !isEnabled()) return;

    const doomKey = toDoomKey(event);
    if (!doomKey) return;
    const id = `${event.code}`;
    if (pressed.has(id)) return; // ignore auto-repeat
    pressed.add(id);
    doom.pushKey(true, doomKey);
  };

  const up = (event) => {
    const doomKey = toDoomKey(event);
    pressed.delete(event.code);
    if (isEnabled && !isEnabled()) return;
    if (!doomKey) return;
    doom.pushKey(false, doomKey);
  };

  const blur = () => {
    // Releasing everything avoids "stuck running" after tabbing away.
    for (const code of pressed) {
      const fake = { code, key: code.length === 1 ? code.toLowerCase() : "" };
      const doomKey = toDoomKey(fake);
      if (doomKey) doom.pushKey(false, doomKey);
    }
    pressed.clear();
  };

  window.addEventListener("keydown", down, { passive: false });
  window.addEventListener("keyup", up);
  window.addEventListener("blur", blur);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) blur();
  });

  return () => {
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
    window.removeEventListener("blur", blur);
  };
}

/**
 * Turns mouse movement into arrow key presses.
 *
 * Mouse deltas accumulate into a rotation budget; every game tick the shooter
 * holds the matching arrow down while there is budget left.  Sensitivity is
 * expressed in "DOOM degrees per pixel".
 */
export class MouseTurner {
  constructor(doom, { sensitivity = 0.28, fireButton = 0 } = {}) {
    this.doom = doom;
    this.sensitivity = sensitivity;
    this.fireButton = fireButton;
    this.pending = 0;
    this.firing = false;
    this.held = null;
    this.enabled = false;
  }

  addMovement(dx) {
    if (!this.enabled) return;
    this.pending += dx * this.sensitivity;
    // Cap the backlog so a fast flick does not spin forever.
    const cap = 12;
    if (this.pending > cap) this.pending = cap;
    if (this.pending < -cap) this.pending = -cap;
  }

  setFiring(firing) {
    if (firing === this.firing) return;
    this.firing = firing;
    this.doom.pushKey(firing, DOOM_KEY.FIRE);
  }

  /** Called once per game tic. */
  update() {
    const wanted = this.pending > 0.5 ? DOOM_KEY.RIGHTARROW : this.pending < -0.5 ? DOOM_KEY.LEFTARROW : null;
    if (wanted !== this.held) {
      if (this.held !== null) this.doom.pushKey(false, this.held);
      if (wanted !== null) this.doom.pushKey(true, wanted);
      this.held = wanted;
    }
    if (wanted !== null) this.pending -= Math.sign(this.pending) * 1.6;
    if (Math.abs(this.pending) < 0.5) this.pending = 0;
  }

  release() {
    if (this.held !== null) {
      this.doom.pushKey(false, this.held);
      this.held = null;
    }
    this.setFiring(false);
    this.pending = 0;
  }
}

/** Mouse + pointer lock wiring for a canvas. */
export function attachMouse(doom, canvas, options = {}) {
  const turner = new MouseTurner(doom, options);

  const onClick = () => {
    if (document.pointerLockElement !== canvas) {
      canvas.requestPointerLock?.();
    }
  };

  const onMovement = (event) => turner.addMovement(event.movementX || 0);

  const onMouseDown = (event) => {
    if (document.pointerLockElement === canvas && event.button === 0) {
      turner.setFiring(true);
    }
  };
  const onMouseUp = (event) => {
    if (event.button === 0) turner.setFiring(false);
  };

  const onLockChange = () => {
    turner.enabled = document.pointerLockElement === canvas;
    if (!turner.enabled) turner.release();
  };

  canvas.addEventListener("click", onClick);
  document.addEventListener("mousemove", onMovement);
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  document.addEventListener("pointerlockchange", onLockChange);

  return { turner, canvas };
}

/** Touch gamepad: press/release DOOM keys while buttons are held. */
export function attachTouch(doom, container, element) {
  const mapping = {
    up: DOOM_KEY.UPARROW,
    down: DOOM_KEY.DOWNARROW,
    left: DOOM_KEY.LEFTARROW,
    right: DOOM_KEY.RIGHTARROW,
    fire: DOOM_KEY.FIRE,
    use: DOOM_KEY.USE,
    run: DOOM_KEY.RSHIFT,
    map: DOOM_KEY.TAB,
  };

  const held = new Set();

  const press = (name, element) => {
    if (held.has(name)) return;
    held.add(name);
    doom.pushKey(true, mapping[name]);
    element.classList.add("active");
  };
  const release = (name, element) => {
    if (!held.has(name)) return;
    held.delete(name);
    doom.pushKey(false, mapping[name]);
    element.classList.remove("active");
  };

  for (const button of container.querySelectorAll("[data-key]")) {
    const name = button.dataset.key;
    const start = (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      press(name, button);
    };
    const end = (event) => {
      event.preventDefault();
      release(name, button);
    };
    button.addEventListener("pointerdown", start);
    button.addEventListener("pointerup", end);
    button.addEventListener("pointercancel", end);
    button.addEventListener("pointerleave", end);
    button.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  const touchDevice = matchMedia("(hover: none), (pointer: coarse)").matches;
  if (touchDevice) element.hidden = false;

  return {
    setVisible(visible) {
      element.hidden = !visible;
    },
    releaseAll() {
      for (const name of [...held]) {
        const button = container.querySelector(`[data-key="${name}"]`);
        release(name, button || document.createElement("button"));
      }
    },
    pressed: held,
  };
}
