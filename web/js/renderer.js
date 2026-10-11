/**
 * renderer.js - put the engine's framebuffer on the screen.
 *
 * The engine renders 640x400 into its own memory as 32 bit words with the byte
 * order R,G,B,A (alpha is unused - see src/doomgeneric_web.c and i_video.c).
 * We never touch those bytes: they are uploaded as a GL texture and drawn 1:1,
 * with the canvas itself scaled up by an integer factor so the pixels stay
 * crisp and sharp.
 */

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });

    if (!this.gl) {
      // Older or locked-down browsers: fall back to a plain 2D canvas.  Slower,
      // but the game still plays.
      this.mode = "2d";
      this.context2d = canvas.getContext("2d", { alpha: false });
      if (!this.context2d) throw new Error("neither WebGL2 nor Canvas2D is available");
      this.width = 0;
      this.height = 0;
      this.frames = 0;
      this.gl = null;
      this.uniforms = null;
      return;
    }

    this.mode = "webgl2";

    const gl = this.gl;
    this.program = this._createProgram();
    gl.useProgram(this.program);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // Full-screen triangle, no vertex buffers needed.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.uniforms = {
      texture: gl.getUniformLocation(this.program, "u_texture"),
      scale: gl.getUniformLocation(this.program, "u_scale"),
    };
    this.width = 0;
    this.height = 0;
    this.frames = 0;
  }

  _createProgram() {
    const gl = this.gl;
    const vertex = `#version 300 es
      // Full screen triangle generated from gl_VertexID - no buffers.
      out vec2 v_uv;
      uniform vec2 u_scale;
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        v_uv = p;
        gl_Position = vec4((p * 2.0 - 1.0) * u_scale, 0.0, 1.0);
      }`;
    const fragment = `#version 300 es
      precision mediump float;
      in vec2 v_uv;
      uniform sampler2D u_texture;
      out vec4 out_color;
      void main() {
        out_color = vec4(texture(u_texture, v_uv).rgb, 1.0);
      }`;

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  /**
   * Upload one frame of engine output.
   * @param {Uint8Array} pixels RGBA bytes straight out of wasm memory.
   */
  upload(pixels, width, height) {
    if (this.mode === "2d") {
      this._upload2d(pixels, width, height);
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (width !== this.width || height !== this.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      this.width = width;
      this.height = height;
      this._resizeCanvas();
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    this.frames++;
  }

  _upload2d(pixels, width, height) {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.context2d.canvas.width = width;
      this.context2d.canvas.height = height;
    }
    // The engine writes RGBA bytes; ImageData wants exactly that, so a single
    // copy is enough (alpha is forced opaque as DOOM never writes it).
    if (!this._imageData || this._imageData.width !== width || this._imageData.height !== height) {
      this._imageData = this.context2d.createImageData(width, height);
      const data = this._imageData.data;
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
    }
    const target = this._imageData.data;
    for (let i = 0; i < target.length; i += 4) {
      target[i] = pixels[i];
      target[i + 1] = pixels[i + 1];
      target[i + 2] = pixels[i + 2];
    }
    this.context2d.putImageData(this._imageData, 0, 0);
    this.frames++;
  }

  /** Size the canvas to the largest integer multiple that fits its box. */
  _resizeCanvas() {
    const canvas = this.canvas;
    if (this.mode === "2d") {
      const box = canvas.parentElement?.getBoundingClientRect?.() ?? { width: 1280, height: 800 };
      const scale = Math.max(1, Math.min((box.width || 1280) / this.width, (box.height || 800) / this.height));
      const width = Math.round(this.width * scale);
      const height = Math.round(this.height * scale);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.imageRendering = "pixelated";
      this.scale = scale;
      return;
    }
    const box = canvas.parentElement?.getBoundingClientRect();
    const maxWidth = Math.max(320, (box?.width ?? window.innerWidth) - 8);
    const maxHeight = Math.max(200, (box?.height ?? window.innerHeight) - 8);

    let scale = Math.min(maxWidth / this.width, maxHeight / this.height);
    // Prefer exact pixel multiples; never go below 1x.
    scale = scale >= 1 ? Math.floor(scale * 2) / 2 : scale;
    const screenWidth = Math.round(this.width * scale);
    const screenHeight = Math.round(this.height * scale);

    canvas.width = screenWidth;
    canvas.height = screenHeight;
    canvas.style.width = `${screenWidth}px`;
    canvas.style.height = `${screenHeight}px`;

    // The viewport is the canvas' own resolution; u_scale is identity then.
    this.gl.viewport(0, 0, screenWidth, screenHeight);
    this.gl.uniform2f(this.uniforms.scale, 1, 1);
    this.scale = scale;
  }

  resize() {
    if (this.width) this._resizeCanvas();
  }

  draw() {
    if (this.mode === "2d") return; // putImageData already presented it
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.useProgram(this.program);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Grab the current canvas as a PNG data URL (used for screenshots). */
  snapshot() {
    return this.canvas.toDataURL("image/png");
  }
}
