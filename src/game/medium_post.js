// Phone-safe lightweight post-processing for Medium quality:
// 1/4-res bright/neon extract -> 1/8-res separable Gaussian blur -> 1 composite + ACES film grade pass.
// Costs < ~1 ms on mobile / WebGL2 while giving Medium neon bloom and cinematic grading.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const extractFragment = `
  uniform sampler2D tDiffuse;
  uniform vec2 texel;
  uniform float threshold;
  varying vec2 vUv;

  vec3 safeSample(vec2 uv) {
    vec3 c = texture2D(tDiffuse, uv).rgb;
    float s = c.r + c.g + c.b;
    return (s >= 0.0 && s < 60000.0) ? clamp(c, vec3(0.0), vec3(24.0)) : vec3(0.0);
  }

  void main() {
    // 4-tap bilinear box downsample (covers 4x4 full-res pixels cleanly with zero shimmer)
    vec3 c = (safeSample(vUv + vec2(-texel.x, -texel.y))
            + safeSample(vUv + vec2( texel.x, -texel.y))
            + safeSample(vUv + vec2(-texel.x,  texel.y))
            + safeSample(vUv + vec2( texel.x,  texel.y))) * 0.25;
    // Soft-knee luminance + chromatic vibrance boost so saturated neon signs glow cleanly
    float peak = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float chroma = peak - minC;
    float metric = peak + chroma * 0.28;
    float knee = 0.25;
    float soft = clamp(metric - threshold + knee, 0.0, 2.0 * knee);
    soft = (soft * soft) / max(4.0 * knee, 1e-4);
    float contrib = max(soft, metric - threshold) / max(metric, 1e-4);
    gl_FragColor = vec4(c * max(contrib, 0.0), 1.0);
  }
`;

const blurFragment = `
  uniform sampler2D tDiffuse;
  uniform vec2 stepDir;
  varying vec2 vUv;

  void main() {
    // 5-tap bilinear-optimized 9-pixel Gaussian
    vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
    c += (texture2D(tDiffuse, clamp(vUv + stepDir * 1.384615, 0.001, 0.999)).rgb
        + texture2D(tDiffuse, clamp(vUv - stepDir * 1.384615, 0.001, 0.999)).rgb) * 0.316216;
    c += (texture2D(tDiffuse, clamp(vUv + stepDir * 3.230769, 0.001, 0.999)).rgb
        + texture2D(tDiffuse, clamp(vUv - stepDir * 3.230769, 0.001, 0.999)).rgb) * 0.070270;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const compositeFragment = `
  uniform sampler2D tDiffuse, tBloom;
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
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float s = c.r + c.g + c.b;
    if (!(s >= 0.0 && s < 60000.0)) c = vec3(0.0);
    c = clamp(c, 0.0, 48.0);
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    float bs = bloom.r + bloom.g + bloom.b;
    if (bs >= 0.0 && bs < 60000.0) c += bloom * bloomStrength;
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
    const caps = renderer.capabilities;
    const useHalf = caps.isWebGL2 || renderer.extensions.has('EXT_color_buffer_half_float');
    const type = useHalf ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const linear = { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false };

    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, {
      type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false, samples: 0,
    });
    this.qRT = new THREE.WebGLRenderTarget(2, 2, linear);
    this.bRT1 = new THREE.WebGLRenderTarget(2, 2, linear);
    this.bRT2 = new THREE.WebGLRenderTarget(2, 2, linear);

    this.extractMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.sceneRT.texture }, texel: { value: new THREE.Vector2(0.25, 0.25) }, threshold: { value: 0.72 } },
      vertexShader: VERT, fragmentShader: extractFragment, depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, stepDir: { value: new THREE.Vector2(0.5, 0) } },
      vertexShader: VERT, fragmentShader: blurFragment, depthTest: false, depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.sceneRT.texture },
        tBloom: { value: this.bRT2.texture },
        exposure: { value: 1.0 }, sat: { value: 0.92 }, curve: { value: 0.0 }, bloomStrength: { value: 0.42 },
      },
      vertexShader: VERT, fragmentShader: compositeFragment, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.compMat);
    this.w = 0; this.h = 0;
  }

  setLook({ exposure, sat, curve, bloomStrength = 0.42, bloomThreshold = 0.72 }) {
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
    const qw = Math.max(2, pw >> 2), qh = Math.max(2, ph >> 2);
    const bw = Math.max(2, pw >> 3), bh = Math.max(2, ph >> 3);
    this.sceneRT.setSize(pw, ph);
    this.qRT.setSize(qw, qh);
    this.bRT1.setSize(bw, bh);
    this.bRT2.setSize(bw, bh);
    this.extractMat.uniforms.texel.value.set(1 / pw, 1 / ph);
    this.bw = bw; this.bh = bh;
  }

  render(renderer, scene, camera) {
    const size = renderer.getDrawingBufferSize(_sz);
    this.setSize(size.x, size.y);

    const prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;

    // 1. Render HDR scene into offscreen RT (no MSAA)
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(scene, camera);

    // 2. Quarter-res bright/neon extract
    this.quad.material = this.extractMat;
    renderer.setRenderTarget(this.qRT);
    this.quad.render(renderer);

    // 3. Eighth-res separable Gaussian blur (H then V)
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tDiffuse.value = this.qRT.texture;
    this.blurMat.uniforms.stepDir.value.set(1.0 / this.bw, 0.0);
    renderer.setRenderTarget(this.bRT1);
    this.quad.render(renderer);

    this.blurMat.uniforms.tDiffuse.value = this.bRT1.texture;
    this.blurMat.uniforms.stepDir.value.set(0.0, 1.0 / this.bh);
    renderer.setRenderTarget(this.bRT2);
    this.quad.render(renderer);

    // 4. Composite bloom + ACES + film grade directly to screen
    this.quad.material = this.compMat;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);

    renderer.toneMapping = prevTM;
  }

  dispose() {
    this.sceneRT.dispose();
    this.qRT.dispose();
    this.bRT1.dispose();
    this.bRT2.dispose();
    this.extractMat.dispose();
    this.blurMat.dispose();
    this.compMat.dispose();
    this.quad.dispose();
  }
}

const _sz = new THREE.Vector2();
