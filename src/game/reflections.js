// Wet-street reflections (High / Ultra, maps that ask for them).
//
// Half-resolution screen-space reflection trace driven by the shared world-space
// wetness mask (gutter puddles, wheel ruts, dry road crowns), emitter-gated so
// only bright neon/lamps/headlights reflect, followed by a 2-pass anisotropic
// depth-aware blur (strong vertical stretch + horizontal typography breakup) and
// an asphalt-grain-broken full-res composite.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ROAD_WETNESS_GLSL } from '../world/road_shader.js';

const MARCH_STEPS = 16;        // coarse steps along the mirrored ray (at half-res)
const REFINE_STEPS = 2;        // binary search between last miss and hit
const MAX_DIST = 68;           // metres a reflected ray may travel
const GROUND_MAX_Y = 0.44;     // street + sidewalk level; car bodies and roofs are higher
const GROUND_FLATNESS = 0.93;  // reconstructed normal.y above this = flat ground
const HDR_CAP = 18;            // cap reflected HDR so neon cannot blow out bloom

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const COMMON_GLSL = `
  uniform sampler2D tDepth;
  uniform mat4 invProj, camWorld;
  uniform float cameraNear, cameraFar;

  vec3 worldAt(vec2 uv, float d) {
    vec4 v = invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    v /= max(abs(v.w), 1e-5) * (v.w < 0.0 ? -1.0 : 1.0);
    return (camWorld * v).xyz;
  }
  float viewZ(float d) {
    float z = d * 2.0 - 1.0;
    float denom = cameraFar + cameraNear - z * (cameraFar - cameraNear);
    return -(2.0 * cameraNear * cameraFar) / max(abs(denom), 1e-4);
  }
  vec3 safeHdr(vec3 c) {
    float s = c.r + c.g + c.b;
    return (s >= 0.0 && s < 60000.0) ? clamp(c, vec3(0.0), vec3(${HDR_CAP.toFixed(1)})) : vec3(0.0);
  }
  vec2 groundCheck(vec2 uv, float d, vec3 wp, vec2 stepUv) {
    vec3 wR = worldAt(uv + vec2(stepUv.x, 0.0), texture2D(tDepth, uv + vec2(stepUv.x, 0.0)).x);
    vec3 wL = worldAt(uv - vec2(stepUv.x, 0.0), texture2D(tDepth, uv - vec2(stepUv.x, 0.0)).x);
    vec3 wU = worldAt(uv + vec2(0.0, stepUv.y), texture2D(tDepth, uv + vec2(0.0, stepUv.y)).x);
    vec3 wD = worldAt(uv - vec2(0.0, stepUv.y), texture2D(tDepth, uv - vec2(0.0, stepUv.y)).x);
    vec3 dx = abs(wR.y - wp.y) < abs(wL.y - wp.y) ? (wR - wp) : (wp - wL);
    vec3 dy = abs(wU.y - wp.y) < abs(wD.y - wp.y) ? (wU - wp) : (wp - wD);
    vec3 cr = cross(dx, dy);
    float cl = length(cr);
    float ny = cl > 1e-6 ? abs(cr.y / cl) : 0.0;
    float jump = max(min(abs(wR.y - wp.y), abs(wL.y - wp.y)), min(abs(wU.y - wp.y), abs(wD.y - wp.y)));
    return vec2(ny, jump);
  }
`;

// Pass 1: Half-resolution SSR trace -> RGBA HalfFloat (premultiplied rgb, a = hit confidence)
const traceFragment = `
  uniform sampler2D tDiffuse;
  uniform mat4 proj, view;
  uniform vec3 camPos;
  uniform vec2 invSize;
  varying vec2 vUv;
  ${COMMON_GLSL}
  ${ROAD_WETNESS_GLSL}

  float bayer4(vec2 p) {
    vec2 f = mod(floor(p), 4.0);
    float x = f.x, y = f.y;
    float a = mod(x, 2.0) + 2.0 * mod(y, 2.0);
    float b = floor(x * 0.5) + 2.0 * floor(y * 0.5);
    float m0 = mod(a * 3.0 + (a > 1.5 ? 1.0 : 0.0), 4.0);
    float m1 = mod(b * 3.0 + (b > 1.5 ? 1.0 : 0.0), 4.0);
    return (m0 * 4.0 + m1) / 16.0;
  }

  void main() {
    gl_FragColor = vec4(0.0);
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.9999) return;
    vec3 wp = worldAt(vUv, d);
    if (wp.y > ${GROUND_MAX_Y.toFixed(2)}) return;

    vec4 wet = rwEvalWetness(wp.xz, wp.y);
    float damp = wet.x, puddle = wet.y;
    if (puddle < 0.05 && (wp.y > 0.06 || damp < 0.20)) return;

    vec2 gc = groundCheck(vUv, d, wp, invSize);
    if (gc.x < ${GROUND_FLATNESS.toFixed(2)} || gc.y > 0.09) return;

    vec3 diff = wp - camPos;
    float dist = length(diff);
    if (dist < 0.05) return;
    vec3 vdir = diff / dist;
    if (vdir.y >= -0.005) return;

    float gr1 = rwNoise(wp.xz * 7.5) - 0.5;
    float scatter = mix(0.036, 0.004, puddle);
    vec3 r = normalize(vec3(vdir.x + gr1 * scatter * 0.65, max(0.015, -vdir.y + gr1 * scatter * 1.4), vdir.z - gr1 * scatter * 0.65));

    float bay = bayer4(gl_FragCoord.xy);
    float stepLen = 0.42;
    float t = 0.22 + stepLen * bay * 0.65;
    float tPrev = 0.0;
    vec2 hitUv = vec2(-1.0);
    float hitT = ${MAX_DIST.toFixed(1)};

    for (int i = 0; i < ${MARCH_STEPS}; i++) {
      vec3 q = wp + r * t;
      vec4 c = proj * view * vec4(q, 1.0);
      if (c.w <= 0.01) break;
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      float sceneZ = viewZ(texture2D(tDepth, uv).x);
      float qZ = (view * vec4(q, 1.0)).z;
      float gap = sceneZ - qZ;
      float thick = stepLen * 1.8 + 0.48;
      if (gap > 0.0 && gap < thick) {
        float a = tPrev, b = t;
        for (int k = 0; k < ${REFINE_STEPS}; k++) {
          float m = (a + b) * 0.5;
          vec3 qm = wp + r * m;
          vec4 cm = proj * view * vec4(qm, 1.0);
          float cw = max(cm.w, 0.01);
          vec2 um = clamp(cm.xy / cw * 0.5 + 0.5, 0.0, 1.0);
          if (viewZ(texture2D(tDepth, um).x) - (view * vec4(qm, 1.0)).z > 0.0) b = m; else a = m;
        }
        vec3 qb = wp + r * b;
        vec4 cb = proj * view * vec4(qb, 1.0);
        if (cb.w > 0.01) {
          hitUv = cb.xy / cb.w * 0.5 + 0.5;
          hitT = b;
        }
        break;
      }
      tPrev = t;
      stepLen *= 1.33;
      t += stepLen;
      if (t > ${MAX_DIST.toFixed(1)}) break;
    }

    if (hitUv.x < 0.0 || hitUv.x > 1.0 || hitUv.y < 0.0 || hitUv.y > 1.0) return;
    float hitD = texture2D(tDepth, hitUv).x;
    if (hitD >= 0.9999) {
      vec3 skyC = safeHdr(texture2D(tDiffuse, hitUv).rgb);
      vec2 eSky = smoothstep(vec2(0.0), vec2(0.09), hitUv) * smoothstep(vec2(0.0), vec2(0.09), 1.0 - hitUv);
      float fSky = eSky.x * eSky.y * mix(0.06, 0.22, puddle);
      gl_FragColor = vec4(skyC * fSky, fSky);
      return;
    }

    // 5-tap vertical pre-filter scaled by travel distance to smear sharp signage vertically
    float sp = clamp(hitT * 0.00032 + 0.0024, 0.0024, 0.019);
    vec3 refl = safeHdr(texture2D(tDiffuse, hitUv).rgb) * 0.28
              + (safeHdr(texture2D(tDiffuse, clamp(hitUv + vec2(0.0, sp), 0.001, 0.999)).rgb)
               + safeHdr(texture2D(tDiffuse, clamp(hitUv - vec2(0.0, sp), 0.001, 0.999)).rgb)) * 0.22
              + (safeHdr(texture2D(tDiffuse, clamp(hitUv + vec2(0.0, sp * 2.4), 0.001, 0.999)).rgb)
               + safeHdr(texture2D(tDiffuse, clamp(hitUv - vec2(0.0, sp * 2.4), 0.001, 0.999)).rgb)) * 0.14;

    // Gate toward bright emitters (neon signs, lamps, car lights)
    float peak = max(refl.r, max(refl.g, refl.b));
    float emitW = mix(smoothstep(0.16, 0.72, peak), smoothstep(0.08, 0.42, peak), puddle * 0.70);
    refl *= emitW;

    vec2 edge = smoothstep(vec2(0.0), vec2(0.08), hitUv) * smoothstep(vec2(0.0), vec2(0.08), 1.0 - hitUv);
    float distFade = 1.0 - smoothstep(${(MAX_DIST * 0.55).toFixed(1)}, ${MAX_DIST.toFixed(1)}, hitT);
    float fade = clamp(edge.x * edge.y * distFade, 0.0, 1.0);
    gl_FragColor = vec4(refl * fade, fade);
  }
`;

// Passes 2 & 3: 5-tap depth-aware separable blur at half resolution (H + wide V streak)
const blurFragment = `
  uniform sampler2D tRefl, tDepth;
  uniform vec2 dir;
  uniform float cameraNear, cameraFar;
  varying vec2 vUv;

  float viewZ(float d) {
    float z = d * 2.0 - 1.0;
    float denom = cameraFar + cameraNear - z * (cameraFar - cameraNear);
    return -(2.0 * cameraNear * cameraFar) / max(abs(denom), 1e-4);
  }

  void main() {
    float cZ = viewZ(texture2D(tDepth, vUv).x);
    float depthTol = max(0.40, abs(cZ) * 0.08);
    vec4 acc = texture2D(tRefl, vUv) * 0.28;
    float wSum = 0.28;

    const float offs[2] = float[2](1.9, 4.5);
    const float wts[2]  = float[2](0.24, 0.12);
    for (int i = 0; i < 2; i++) {
      vec2 duv = dir * offs[i];
      vec2 uvP = clamp(vUv + duv, 0.001, 0.999);
      vec2 uvN = clamp(vUv - duv, 0.001, 0.999);
      float zP = viewZ(texture2D(tDepth, uvP).x);
      float zN = viewZ(texture2D(tDepth, uvN).x);
      float kP = wts[i] * exp(-abs(zP - cZ) / depthTol);
      float kN = wts[i] * exp(-abs(zN - cZ) / depthTol);
      acc += texture2D(tRefl, uvP) * kP + texture2D(tRefl, uvN) * kN;
      wSum += kP + kN;
    }
    gl_FragColor = acc / max(wSum, 1e-4);
  }
`;

// Pass 4: Full-resolution grain-broken composite onto the HDR scene buffer
const compositeFragment = `
  uniform sampler2D tDiffuse, tRefl;
  uniform vec3 camPos;
  uniform vec2 invFullSize;
  uniform float strength, wetBase;
  varying vec2 vUv;
  ${COMMON_GLSL}
  ${ROAD_WETNESS_GLSL}

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    gl_FragColor = base;
    if (strength <= 0.001) return;

    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.9999) return;
    vec3 wp = worldAt(vUv, d);
    if (wp.y > ${GROUND_MAX_Y.toFixed(2)}) return;

    vec2 gc = groundCheck(vUv, d, wp, invFullSize);
    float flatMask = smoothstep(0.90, 0.97, gc.x)
                   * (1.0 - smoothstep(0.24, ${GROUND_MAX_Y.toFixed(2)}, wp.y))
                   * (1.0 - smoothstep(0.035, 0.095, gc.y));
    if (flatMask <= 0.005) return;

    vec4 wet = rwEvalWetness(wp.xz, wp.y);
    float damp = wet.x, puddle = wet.y;
    float isWalk = smoothstep(0.06, 0.13, wp.y);

    vec3 diff = wp - camPos;
    float dist = length(diff);
    vec3 vdir = diff / max(dist, 1e-4);
    float cosV = clamp(-vdir.y, 0.0, 1.0);
    float f1 = 1.0 - cosV;
    float f2 = f1 * f1;
    float fres = 0.02 + 0.98 * f2 * f2 * f1;

    float g1 = rwNoise(wp.xz * 5.2) - 0.5;
    vec2 jit = mix(
      vec2(g1 * 0.0095, g1 * 0.028),
      vec2(g1 * 0.0022, g1 * 0.0055),
      puddle
    );
    vec4 r0 = texture2D(tRefl, clamp(vUv + jit, 0.001, 0.999));
    vec4 r1 = texture2D(tRefl, clamp(vUv + jit + vec2(0.0, mix(0.018, 0.004, puddle)), 0.001, 0.999));
    vec4 refl = r0 * 0.60 + r1 * 0.40;
    if (refl.a <= 0.002) return;

    float grainMask = mix(0.55 + 0.90 * abs(g1), 1.0, puddle);
    float baseLum = dot(base.rgb, vec3(0.299, 0.587, 0.114));
    float paintMask = 1.0 - smoothstep(0.24, 0.68, baseLum) * 0.45;

    float puddleAmt = puddle * mix(0.14, 0.88, fres) * mix(1.0, 0.62, isWalk);
    float dampAmt = max(damp, wetBase) * (1.0 - puddle) * mix(0.025, 0.28, fres) * mix(1.0, 0.48, isWalk);
    float k = clamp(strength * (puddleAmt + dampAmt) * flatMask * paintMask * grainMask, 0.0, 0.64);

    vec3 col = base.rgb * (1.0 - k * 0.22 * refl.a) + refl.rgb * k;
    gl_FragColor = vec4(safeHdr(col), base.a);
  }
`;

export class StreetReflectionPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.halfW = 2;
    this.halfH = 2;
    this.fullW = 4;
    this.fullH = 4;

    const rtOpts = {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    };
    this.traceRT = new THREE.WebGLRenderTarget(2, 2, rtOpts);
    this.blurRT = new THREE.WebGLRenderTarget(2, 2, rtOpts);

    const shared = {
      tDepth: { value: null },
      invProj: { value: new THREE.Matrix4() },
      camWorld: { value: new THREE.Matrix4() },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 1000 },
    };
    this._shared = shared;

    this.traceMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        tDiffuse: { value: null },
        proj: { value: new THREE.Matrix4() },
        view: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() },
        invSize: { value: new THREE.Vector2(0.5, 0.5) },
      },
      vertexShader: VERT, fragmentShader: traceFragment, depthTest: false, depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tRefl: { value: null },
        tDepth: shared.tDepth,
        dir: { value: new THREE.Vector2(1 / 2, 0) },
        cameraNear: shared.cameraNear,
        cameraFar: shared.cameraFar,
      },
      vertexShader: VERT, fragmentShader: blurFragment, depthTest: false, depthWrite: false,
    });

    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        tDiffuse: { value: null },
        tRefl: { value: this.traceRT.texture },
        camPos: this.traceMat.uniforms.camPos,
        invFullSize: { value: new THREE.Vector2(0.25, 0.25) },
        strength: { value: 0 },
        wetBase: { value: 0.04 },
      },
      vertexShader: VERT, fragmentShader: compositeFragment, depthTest: false, depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.compMat);
  }

  setSize(width, height) {
    const fw = Math.max(2, Math.floor(width));
    const fh = Math.max(2, Math.floor(height));
    const hw = Math.max(2, Math.floor(fw * 0.5));
    const hh = Math.max(2, Math.floor(fh * 0.5));
    if (fw === this.fullW && fh === this.fullH) return;
    this.fullW = fw; this.fullH = fh;
    this.halfW = hw; this.halfH = hh;
    this.traceRT.setSize(hw, hh);
    this.blurRT.setSize(hw, hh);
    this.traceMat.uniforms.invSize.value.set(1 / hw, 1 / hh);
    this.compMat.uniforms.invFullSize.value.set(1 / fw, 1 / fh);
  }

  /** strength 0 = off for this map; wetBase = baseline dampness on dry crown. */
  setLook(strength, wetBase) {
    this.compMat.uniforms.strength.value = strength;
    this.compMat.uniforms.wetBase.value = wetBase;
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    if (readBuffer.width !== this.fullW || readBuffer.height !== this.fullH) {
      this.setSize(readBuffer.width, readBuffer.height);
    }
    const sh = this._shared;
    sh.tDepth.value = readBuffer.depthTexture;
    sh.invProj.value.copy(cam.projectionMatrixInverse);
    sh.camWorld.value.copy(cam.matrixWorld);
    sh.cameraNear.value = cam.near;
    sh.cameraFar.value = cam.far;

    const tu = this.traceMat.uniforms;
    tu.tDiffuse.value = readBuffer.texture;
    tu.proj.value.copy(cam.projectionMatrix);
    tu.view.value.copy(cam.matrixWorldInverse);
    tu.camPos.value.setFromMatrixPosition(cam.matrixWorld);

    // 1. Half-resolution reflection trace
    this.fsQuad.material = this.traceMat;
    renderer.setRenderTarget(this.traceRT);
    this.fsQuad.render(renderer);

    // 2. Depth-aware horizontal blur (breaks up billboard typography cleanly)
    const bu = this.blurMat.uniforms;
    this.fsQuad.material = this.blurMat;
    bu.tRefl.value = this.traceRT.texture;
    bu.dir.value.set(2.9 / this.halfW, 0.0);
    renderer.setRenderTarget(this.blurRT);
    this.fsQuad.render(renderer);

    // 3. Depth-aware wide vertical blur (anisotropic rain-streak sheen)
    bu.tRefl.value = this.blurRT.texture;
    bu.dir.value.set(0.0, 6.4 / this.halfH);
    renderer.setRenderTarget(this.traceRT);
    this.fsQuad.render(renderer);

    // 4. Full-resolution depth-aware composite onto scene
    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.compMat.uniforms.tRefl.value = this.traceRT.texture;
    this.fsQuad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() {
    this.traceRT.dispose();
    this.blurRT.dispose();
    this.traceMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.fsQuad.dispose();
  }
}
