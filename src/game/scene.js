// Renderer, sky, fog and lighting. setAtmosphere() swaps the look per map: a
// blue-hour Manhattan with the sunset glow lined up with the cross streets, or
// a clear sunny afternoon at the lake.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { setMaxAnisotropy } from '../world/textures.js';

export const QUALITY = {
  // shadow = sun shadow map size (0 = off), post = bloom + film grade pass
  low: { height: 540, draw: 0.7, far: 900, aa: false, shadow: 0, post: false },
  medium: { height: 720, draw: 1.0, far: 1300, aa: false, shadow: 1024, post: false },
  high: { height: 1080, draw: 1.25, far: 1700, aa: true, shadow: 2048, post: true },
  ultra: { height: 1600, draw: 1.6, far: 2100, aa: true, shadow: 4096, post: true },   // Retina laptops and desktops
};

const _fwd = new THREE.Vector3();

// One preset = everything that sets a map's mood. fog.far null = follow the draw distance.
export const ATMOSPHERES = {
  midtown: {
    sky: { top: 0x1d3a66, mid: 0x5f86b3, horizon: 0xd9b08c, haze: 0x56606e, sunCol: 0xffc98a, gain: 1.6, stars: 1 },
    sunDir: [-0.82, 0.44, 0.36], sunColor: 0xffdcb0, sunIntensity: 3.4,
    hemi: { sky: 0xa9c4ee, ground: 0x4a443e, intensity: 0.9 },
    fog: { color: 0x56606e, near: 90, far: null },
    exposure: 1.0, envIntensity: 0.9, envFloor: 0x25262a, shadowR: 55, shadowRadius: 2, shadowNormalBias: 0.05,
    grade: { sat: 0.92, curve: 0, warm: 1.0 },
  },
  // clear sunny afternoon, CoD-Mobile-daytime style: saturated blue zenith, light blue horizon,
  // soft clouds, strong warm sun, rich environment reflections, light blue haze from ~120 m
  lodge: {
    sky: { top: 0x0d47b8, mid: 0x3f8fe6, horizon: 0x9ccbf0, haze: 0x86aed8, sunCol: 0xfff0d0, gain: 1.15, stars: 0, clouds: 0.55 },
    sunDir: [-0.5003, 0.7204, 0.4803], sunColor: 0xffedcc, sunIntensity: 4.6,
    hemi: { sky: 0x80abf2, ground: 0x464c36, intensity: 0.72 },
    fog: { color: 0x7ea8dc, near: 150, far: 2600, uncapped: true },
    exposure: 1.02, envIntensity: 1.12, envFloor: 0x3e4a30, shadowR: 44, shadowRadius: 1.2, shadowNormalBias: 0.03,
    grade: { sat: 1.08, curve: 0.35, warm: 1.0 },
  },
};

export function createScene(canvas, qualityName = 'medium') {
  const q = { ...(QUALITY[qualityName] || QUALITY.medium) };
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: q.aa, alpha: false, stencil: false, powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x1a1c24);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = true;
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(ATMOSPHERES.midtown.fog.color, 90, q.far * 0.82);

  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.12, q.far);
  camera.rotation.order = 'YXZ';

  // sky dome
  const sunDir = new THREE.Vector3(...ATMOSPHERES.midtown.sunDir).normalize();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x1d3a66) },
        mid: { value: new THREE.Color(0x5f86b3) },
        horizon: { value: new THREE.Color(0xd9b08c) },
        haze: { value: new THREE.Color(ATMOSPHERES.midtown.fog.color) },
        sunDir: { value: sunDir },
        sunCol: { value: new THREE.Color(0xffc98a) },
        gain: { value: 1.6 },
        stars: { value: 1 },
        clouds: { value: 0 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: `
        uniform vec3 top, mid, horizon, haze, sunDir, sunCol;
        uniform float gain, stars, clouds;
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(horizon, mid, smoothstep(0.0, 0.28, h));
          col = mix(col, top, smoothstep(0.2, 0.8, h));
          float s = max(dot(normalize(vec3(d.x, d.y * 1.6, d.z)), sunDir), 0.0);
          col += sunCol * (pow(s, 5.0) * 0.55 + pow(s, 40.0) * 0.9);
          // a few stars high up
          vec2 g = floor(d.xz / max(0.15, d.y) * 90.0);
          float star = step(0.9975, hash(g)) * smoothstep(0.35, 0.8, h);
          col += vec3(star) * 0.8 * stars;
          if (clouds > 0.0 && h > 0.0) {
            // a flat cloud layer: soft cumulus, bright rims towards the sun, grey-blue undersides
            vec2 cp = d.xz / (h + 0.18) * 2.6 + vec2(3.1, 7.3);
            float cn = vnoise(cp) * 0.55 + vnoise(cp * 2.1) * 0.3 + vnoise(cp * 4.3) * 0.15;
            float cv = smoothstep(0.52 - clouds * 0.25, 0.82, cn) * smoothstep(0.0, 0.22, h);
            vec3 cc = mix(vec3(0.62, 0.72, 0.86), vec3(1.0, 0.98, 0.94), smoothstep(0.55, 0.9, cn));
            cc += sunCol * pow(s, 8.0) * 0.5;
            col = mix(col, cc * 1.05, cv * 0.92);
          }
          col = mix(col, haze, smoothstep(0.06, -0.04, h));
          gl_FragColor = vec4(col * gain, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // image-based lighting: the sky itself, prefiltered, so metal and glass
  // have something real to reflect. Rebuilt whenever the atmosphere changes.
  let envTarget = null;
  const envScene = new THREE.Scene();
  const envSky = sky.clone();   // shares the sky material, hence its uniforms
  envSky.scale.setScalar(50);
  envScene.add(envSky);
  // a dark ground half so reflections are not sky-bright from below
  const envFloor = new THREE.Mesh(new THREE.CircleGeometry(60, 16), new THREE.MeshBasicMaterial({ color: 0x25262a }));
  envFloor.rotation.x = -Math.PI / 2; envFloor.position.y = -1.5;
  envScene.add(envFloor);
  function buildEnvironment() {
    const pm = new THREE.PMREMGenerator(renderer);
    const tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    const rt = pm.fromScene(envScene, 0.02, 0.1, 100);
    renderer.toneMapping = tm;
    scene.environment = rt.texture;
    if (envTarget) envTarget.dispose();
    envTarget = rt;
    pm.dispose();
  }

  const hemi = new THREE.HemisphereLight(0xa9c4ee, 0x4a443e, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffdcb0, 3.4);
  sun.position.copy(sunDir).multiplyScalar(100);
  scene.add(sun);
  scene.add(sun.target);
  let SHADOW_R = ATMOSPHERES.midtown.shadowR, shadowRadius = 2, shadowNormalBias = 0.05;
  let fogFar = null;   // the preset's own fog distance (null: follow the draw distance)
  let fogUncapped = false;
  const fogFarNow = () => (fogUncapped && fogFar ? fogFar : Math.min(fogFar || Infinity, q.far * 0.82));
  function setupShadow() {
    sun.castShadow = q.shadow > 0;
    if (!sun.castShadow) return;
    const sh = sun.shadow;
    if (sh.mapSize.x !== q.shadow) {
      sh.mapSize.set(q.shadow, q.shadow);
      if (sh.map) { sh.map.dispose(); sh.map = null; }
    }
    const c = sh.camera;
    c.left = -SHADOW_R; c.right = SHADOW_R; c.top = SHADOW_R; c.bottom = -SHADOW_R; c.near = 1; c.far = 700;
    c.updateProjectionMatrix();
    sh.bias = -0.0004; sh.normalBias = shadowNormalBias; sh.radius = shadowRadius;
  }
  setupShadow();

  /**
   * Switch the mood: sky colours, sun, hemisphere light, fog, exposure and the
   * sky-derived reflection environment. `arg` is a preset name or
   * { preset, sunDir } (a map may bring its own sun direction).
   */
  function setAtmosphere(arg) {
    const name = typeof arg === 'string' ? arg : arg.preset;
    const A = ATMOSPHERES[name] || ATMOSPHERES.midtown;
    const u = sky.material.uniforms;
    u.top.value.set(A.sky.top); u.mid.value.set(A.sky.mid); u.horizon.value.set(A.sky.horizon);
    u.haze.value.set(A.sky.haze); u.sunCol.value.set(A.sky.sunCol);
    u.gain.value = A.sky.gain; u.stars.value = A.sky.stars; u.clouds.value = A.sky.clouds || 0;
    const sd = (typeof arg === 'object' && arg.sunDir) || A.sunDir;
    sunDir.set(sd[0], sd[1], sd[2]).normalize();
    sun.color.set(A.sunColor);
    sun.intensity = A.sunIntensity;
    sun.position.copy(sunDir).multiplyScalar(100);
    hemi.color.set(A.hemi.sky); hemi.groundColor.set(A.hemi.ground); hemi.intensity = A.hemi.intensity;
    scene.fog.color.set(A.fog.color);
    scene.fog.near = A.fog.near;
    fogFar = A.fog.far; fogUncapped = !!A.fog.uncapped;
    scene.fog.far = fogFarNow();
    renderer.toneMappingExposure = A.exposure;
    if (exposureU) exposureU.value = A.exposure;
    envFloor.material.color.set(A.envFloor);
    scene.environmentIntensity = A.envIntensity;
    SHADOW_R = A.shadowR; shadowRadius = A.shadowRadius; shadowNormalBias = A.shadowNormalBias;
    pendingGrade = A.grade;
    if (gradeU) { gradeU.sat.value = A.grade.sat; gradeU.curve.value = A.grade.curve; }
    setupShadow();
    buildEnvironment();
  }

  // post: bloom on the neon and sun glints, then tone map + a restrained film grade
  let pendingGrade = null;
  let composer = null, bloom = null, exposureU = null, gradeU = null;
  function setupPost() {
    if (!q.post) { composer = null; return; }
    if (composer) return;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: q.aa ? 4 : 0 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    // Phone GPUs can leave a few NaN / infinite pixels in the half-float buffer
    // (tiny-roughness sun glints overflow it). The bloom blur would smear each
    // one into a big black square, so clean them up and cap the range first.
    composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float s = c.r + c.g + c.b;
          // written so it holds even where the driver folds isnan() away: NaN fails every comparison
          if (any(isnan(c)) || any(isinf(c)) || !(s >= 0.0 && s < 60000.0)) c = vec3(0.0);
          gl_FragColor = vec4(clamp(c, 0.0, 48.0), 1.0);
        }`,
    }));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 1.0);
    composer.addPass(bloom);
    const grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, exposure: { value: renderer.toneMappingExposure }, sat: { value: 0.92 }, curve: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float exposure, sat, curve; varying vec2 vUv;
        vec3 aces(vec3 x) { x *= exposure / 0.6;
          const mat3 a = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
          const mat3 b = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
          x = a * x; vec3 n = x * (x + 0.0245786) - 0.000090537; vec3 d = x * (0.983729 * x + 0.4329510) + 0.238081;
          return clamp(b * (n / d), 0.0, 1.0); }
        void main() {
          vec3 c = aces(texture2D(tDiffuse, vUv).rgb);
          // slight desaturation, cool shadows / warm highlights, vignette
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, sat);
          c = mix(c, c * c * (3.0 - 2.0 * c), curve);   // S-curve contrast (0 = off)
          c *= mix(vec3(0.96, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.0, 0.7, l));
          vec2 v = vUv - 0.5; c *= 1.0 - dot(v, v) * 0.42;
          gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
        }`,
    });
    exposureU = grade.uniforms.exposure;
    gradeU = grade.uniforms;
    if (pendingGrade) { gradeU.sat.value = pendingGrade.sat; gradeU.curve.value = pendingGrade.curve; }
    composer.addPass(grade);
  }
  setupPost();
  setAtmosphere('midtown');

  let w = 0, h = 0, scale = 1;
  function resize(force) {
    const cw = canvas.clientWidth || window.innerWidth, ch = canvas.clientHeight || window.innerHeight;
    if (!force && cw === w && ch === h) return;
    w = cw; h = ch;
    const dpr = window.devicePixelRatio || 1;
    const ratio = Math.min(dpr, Math.max(0.35, (q.height / Math.max(1, Math.min(cw, ch))) * scale));
    renderer.setPixelRatio(ratio);
    renderer.setSize(cw, ch, false);
    if (composer) { composer.setPixelRatio(ratio); composer.setSize(cw, ch); }
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  }
  resize();

  /** Dynamic resolution: 1 = the quality preset's target, lower = cheaper. */
  function setScale(s) {
    s = Math.max(0.5, Math.min(1, s));
    if (Math.abs(s - scale) < 0.01) return;
    scale = s;
    resize(true);
  }
  function setQuality(name) {
    const n = QUALITY[name] || QUALITY.medium;
    q.height = n.height; q.draw = n.draw; q.far = n.far; q.shadow = n.shadow; q.post = n.post;
    setupShadow(); setupPost();
    camera.far = q.far;
    scene.fog.far = fogFarNow();
    camera.updateProjectionMatrix();
    scale = 1;
    resize(true);
  }

  function render() {
    sky.position.copy(camera.position);
    sky.scale.setScalar(camera.far * 0.9);
    if (sun.castShadow) {
      // keep the shadow box around the player, snapped so it does not shimmer
      const step = (SHADOW_R * 2) / q.shadow * 4;
      camera.getWorldDirection(_fwd);
      const tx = Math.round((camera.position.x + _fwd.x * SHADOW_R * 0.55) / step) * step;
      const tz = Math.round((camera.position.z + _fwd.z * SHADOW_R * 0.55) / step) * step;
      sun.target.position.set(tx, 0, tz);
      sun.position.set(tx + sunDir.x * 300, sunDir.y * 300, tz + sunDir.z * 300);
      sun.target.updateMatrixWorld();
    }
    if (composer) {
      renderer.toneMapping = THREE.NoToneMapping;
      composer.render();
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    } else renderer.render(scene, camera);
  }

  return { renderer, scene, camera, resize, render, setScale, setQuality, setAtmosphere, getScale: () => scale, quality: q, sunDir };
}
