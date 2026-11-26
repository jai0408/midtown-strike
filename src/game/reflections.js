// Wet-street reflections (High / Ultra, maps that ask for them).
//
// A screen-space pass that runs on the HDR frame straight after the scene is
// drawn. For every pixel that is flat ground at street level it mirrors the view
// ray about the ground, marches it through the depth buffer and, where it passes
// behind something on screen (an LED board, a facade, a taxi, a soldier), takes
// that colour. Wet patches and grazing angles reflect more, dry asphalt barely.
// Anything not on screen cannot be reflected; those rays fade out instead.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const MARCH_STEPS = 22;        // coarse steps along the mirrored ray
const REFINE_STEPS = 4;        // binary search between the last miss and the hit
const MAX_DIST = 70;           // metres a reflected ray may travel
const GROUND_MAX_Y = 0.45;     // street + kerb level; roofs and car tops are higher
const GROUND_FLATNESS = 0.94;  // reconstructed normal.y above this = ground
const HDR_CAP = 24;            // cap reflected HDR so neon cannot blow out bloom

const vertexShader = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const fragmentShader = `
  uniform sampler2D tDiffuse, tDepth;
  uniform mat4 proj, invProj, camWorld, view;
  uniform vec3 camPos;
  uniform float strength, wetBase, cameraNear, cameraFar;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }

  vec3 worldAt(vec2 uv, float d) {
    vec4 v = invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    v /= v.w;
    return (camWorld * v).xyz;
  }
  float viewZ(float d) {   // perspective depth -> view-space z (negative in front of the camera)
    float z = d * 2.0 - 1.0;
    return -(2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
  }
  vec3 safe(vec3 c) {
    float s = c.r + c.g + c.b;
    return (s >= 0.0 && s < 60000.0) ? min(c, vec3(${HDR_CAP.toFixed(1)})) : vec3(0.0);
  }

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    float d = texture2D(tDepth, vUv).x;
    vec3 wp = worldAt(vUv, d);
    // derivatives before any branch (they need every pixel of the quad)
    vec3 n = normalize(cross(dFdx(wp), dFdy(wp)));
    gl_FragColor = base;
    if (d >= 1.0 || abs(n.y) < ${GROUND_FLATNESS} || wp.y > ${GROUND_MAX_Y}) return;

    // wet mask: everything a little damp after rain, puddles fully wet
    float puddle = smoothstep(0.55, 0.78, vnoise(wp.xz * 0.031 + 11.0) * 0.7 + vnoise(wp.xz * 0.13) * 0.3);
    float wet = mix(wetBase, 1.0, puddle);
    vec3 vdir = normalize(wp - camPos);
    float cosV = clamp(-vdir.y, 0.0, 1.0);
    float fres = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);
    float amount = strength * wet * mix(0.25, 1.0, fres);
    if (amount < 0.01) return;

    // march the mirrored ray, step length growing with distance
    vec3 r = vec3(vdir.x, -vdir.y, vdir.z);
    float jitter = hash(gl_FragCoord.xy) * 0.6 + 0.7;
    float t = 0.25 * jitter, tPrev = 0.0, stepLen = 0.25 * jitter;
    vec2 hitUv = vec2(-1.0);
    for (int i = 0; i < ${MARCH_STEPS}; i++) {
      vec3 q = wp + r * t;
      vec4 c = proj * view * vec4(q, 1.0);
      if (c.w <= 0.0) break;
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      float sceneZ = viewZ(texture2D(tDepth, uv).x);
      float qZ = (view * vec4(q, 1.0)).z;
      float gap = sceneZ - qZ;           // > 0: the ray point is behind what is drawn there
      if (gap > 0.0 && gap < stepLen * 2.0 + 0.6) {
        // refine between the last point in front and this one
        float a = tPrev, b = t;
        for (int k = 0; k < ${REFINE_STEPS}; k++) {
          float m = (a + b) * 0.5;
          vec3 qm = wp + r * m;
          vec4 cm = proj * view * vec4(qm, 1.0);
          vec2 um = cm.xy / cm.w * 0.5 + 0.5;
          if (viewZ(texture2D(tDepth, um).x) - (view * vec4(qm, 1.0)).z > 0.0) b = m; else a = m;
        }
        vec3 qb = wp + r * b;
        vec4 cb = proj * view * vec4(qb, 1.0);
        hitUv = cb.xy / cb.w * 0.5 + 0.5;
        t = b;
        break;
      }
      tPrev = t;
      stepLen *= 1.32;
      t += stepLen;
      if (t > ${MAX_DIST.toFixed(1)}) break;
    }
    if (hitUv.x < 0.0) return;

    // rough asphalt: a short vertical smear, wider the further the ray went
    float spread = clamp(t * 0.0009, 0.0006, 0.012);
    vec3 refl = safe(texture2D(tDiffuse, hitUv).rgb) * 0.5
              + safe(texture2D(tDiffuse, hitUv + vec2(0.0, spread)).rgb) * 0.25
              + safe(texture2D(tDiffuse, hitUv - vec2(0.0, spread)).rgb) * 0.25;
    // fade at the screen edges and with distance so missing data never pops
    vec2 e = smoothstep(vec2(0.0), vec2(0.07), hitUv) * smoothstep(vec2(0.0), vec2(0.07), 1.0 - hitUv);
    float fade = e.x * e.y * (1.0 - smoothstep(${(MAX_DIST * 0.6).toFixed(1)}, ${MAX_DIST.toFixed(1)}, t));
    float k = clamp(amount * fade, 0.0, 0.85);
    gl_FragColor = vec4(mix(base.rgb, base.rgb * 0.55 + refl, k), base.a);
  }
`;

export class StreetReflectionPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        proj: { value: new THREE.Matrix4() }, invProj: { value: new THREE.Matrix4() },
        camWorld: { value: new THREE.Matrix4() }, view: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() },
        strength: { value: 0 }, wetBase: { value: 0.3 },
        cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
      },
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  /** strength 0 = off for this map; wetBase = how damp the dry parts are. */
  setLook(strength, wetBase) {
    this.material.uniforms.strength.value = strength;
    this.material.uniforms.wetBase.value = wetBase;
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms, cam = this.camera;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.proj.value.copy(cam.projectionMatrix);
    u.invProj.value.copy(cam.projectionMatrixInverse);
    u.camWorld.value.copy(cam.matrixWorld);
    u.view.value.copy(cam.matrixWorldInverse);
    u.camPos.value.setFromMatrixPosition(cam.matrixWorld);
    u.cameraNear.value = cam.near; u.cameraFar.value = cam.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}
