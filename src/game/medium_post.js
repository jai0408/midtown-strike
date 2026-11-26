// Phone-safe lightweight post-processing for Medium quality:
// 1/6-res RGBA8 bright/neon extract (4-tap bilinear) -> composite + 4-tap Kawase bloom gather
// + ACES film grade + vignette (only 2 fullscreen passes total, low memory bandwidth).
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const extractFragment = `
  uniform sampler2D tDiffuse;
  uniform vec2 texel;
  uniform float threshold;
  varying vec2 vUv;

  vec3 safeSample(vec2 uv) {
    vec3 c = texture2D(tDiffuse, clamp(uv, 0.001, 0.999)).rgb;
    float s = c.r + c.g + c.b;
    return (s >= 0.0 && s < 60000.0) ? clamp(c, vec3(0.0), vec3(16.0)) : vec3(0.0);
  }

  void main() {
    // 2 diagonal bilinear taps into 1/8-res RGBA8 target
    vec2 d = texel * 1.5;
    vec3 c = (safeSample(vUv - d) + safeSample(vUv + d)) * 0.5;
    float peak = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    // Chromaticity-weighted metric lets saturated neon signs bloom cleanly even from RGBA8
    float metric = peak + (peak - minC) * 0.32;
    float knee = 0.24;
    float soft = clamp(metric - threshold + knee, 0.0, 2.0 * knee);
    soft = (soft * soft) / max(4.0 * knee, 1e-4);
    float contrib = max(soft, metric - threshold) / max(metric, 1e-4);
    gl_FragColor = vec4(clamp(c * max(contrib, 0.0) * 0.34, 0.0, 1.0), 1.0);
  }
`;

const compositeFragment = `
  uniform sampler2D tDiffuse, tBloom;
  uniform vec2 bloomStep;
  uniform float exposure, sat, curve, bloomStrength;
  varying vec2 vUv;

  vec3 aces(vec3 x) {
    x *= exposure / 0.6;
    const mat3 a = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    const mat3 b = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    x = a * x;
    vec3 n = x * (x + 0.0245786) - 0.000090537;
    vec3 d = x * (0.983729 * x + 0.4329510) + 0.238081;
    return clamp(b * (n / max(d, vec3(1e-4))), 0.0, 1.0);
  }

  void main() {
    // Soft highlight expansion recovers punch for RGBA8 sceneRT before ACES tone mapping
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    c += c * c * c * 0.35;

    // 4-tap Kawase gather from tiny 1/8-res RGBA8 bloom buffer (unpack * 4.0)
    vec3 bloom = (texture2D(tBloom, clamp(vUv + vec2( bloomStep.x,  bloomStep.y), 0.002, 0.998)).rgb
                + texture2D(tBloom, clamp(vUv + vec2(-bloomStep.x,  bloomStep.y), 0.002, 0.998)).rgb
                + texture2D(tBloom, clamp(vUv + vec2( bloomStep.x, -bloomStep.y), 0.002, 0.998)).rgb
                + texture2D(tBloom, clamp(vUv + vec2(-bloomStep.x, -bloomStep.y), 0.002, 0.998)).rgb);
    c += bloom * bloomStrength;

    c = aces(c);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, sat);
    c = mix(c, c * c * (3.0 - 2.0 * c), curve);
    c *= mix(vec3(0.96, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.0, 0.7, l));
    vec2 v = vUv - 0.5;
    c *= 1.0 - dot(v, v) * 0.42;
    gl_FragColor = vec4(pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)), 1.0);
  }
`;

export class MediumPostPipeline {
  constructor(renderer) {
    // 32-bit RGBA8 offscreen targets cut phone memory bandwidth in half vs HalfFloat
    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false, samples: 0,
    });
    // Single 1/8-res RGBA8 bloom buffer (eliminates 2nd blur pass and stays L1-cache resident)
    this.bRT = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });

    this.extractMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.sceneRT.texture }, texel: { value: new THREE.Vector2(0.25, 0.25) }, threshold: { value: 0.62 } },
      vertexShader: VERT, fragmentShader: extractFragment, depthTest: false, depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.sceneRT.texture },
        tBloom: { value: this.bRT.texture },
        bloomStep: { value: new THREE.Vector2(0.01, 0.01) },
        exposure: { value: 1.0 }, sat: { value: 0.95 }, curve: { value: 0.08 }, bloomStrength: { value: 0.48 },
      },
      vertexShader: VERT, fragmentShader: compositeFragment, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.compMat);
    this.w = 0; this.h = 0;
  }

  setLook({ exposure, sat, curve, bloomStrength = 0.48, bloomThreshold = 0.62 }) {
    const cu = this.compMat.uniforms;
    if (exposure !== undefined) cu.exposure.value = exposure;
    if (sat !== undefined) cu.sat.value = sat;
    if (curve !== undefined) cu.curve.value = curve;
    cu.bloomStrength.value = bloomStrength;
    this.extractMat.uniforms.threshold.value = bloomThreshold;
  }

  setSize(w, h) {
    const pw = Math.max(4, Math.floor(w));
    const ph = Math.max(4, Math.floor(h));
    if (pw === this.w && ph === this.h) return;
    this.w = pw; this.h = ph;
    const bw = Math.max(2, pw >> 3), bh = Math.max(2, ph >> 3);
    this.sceneRT.setSize(pw, ph);
    this.bRT.setSize(bw, bh);
    this.extractMat.uniforms.texel.value.set(1 / pw, 1 / ph);
    this.compMat.uniforms.bloomStep.value.set(1.45 / bw, 1.45 / bh);
  }

  render(renderer, scene, camera) {
    const size = renderer.getDrawingBufferSize(_sz);
    this.setSize(size.x, size.y);

    const prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;

    // 1. Render HDR scene into offscreen RT (no MSAA; keep autoClear=true for TBDR LoadActionClear)
    renderer.setRenderTarget(this.sceneRT);
    renderer.render(scene, camera);

    // 2. 1/8-res RGBA8 bright/neon extract with 2-tap diagonal bilinear filter
    this.quad.material = this.extractMat;
    renderer.setRenderTarget(this.bRT);
    this.quad.render(renderer);

    // 3. Composite with 4-tap Kawase gather + ACES + film grade directly to screen
    this.quad.material = this.compMat;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);

    renderer.toneMapping = prevTM;
  }

  dispose() {
    this.sceneRT.dispose();
    this.bRT.dispose();
    this.extractMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}

const _sz = new THREE.Vector2();
