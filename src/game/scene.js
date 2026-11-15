// Renderer, sky, fog and lighting: a blue-hour Manhattan with the sunset glow
// lined up with the cross streets.
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
  const FOG = 0x56606e;
  scene.fog = new THREE.Fog(FOG, 90, q.far * 0.82);

  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.12, q.far);
  camera.rotation.order = 'YXZ';

  // sky dome
  const sunDir = new THREE.Vector3(-0.82, 0.44, 0.36).normalize();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x1d3a66) },
        mid: { value: new THREE.Color(0x5f86b3) },
        horizon: { value: new THREE.Color(0xd9b08c) },
        haze: { value: new THREE.Color(FOG) },
        sunDir: { value: sunDir },
        sunCol: { value: new THREE.Color(0xffc98a) },
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
        varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
          col += vec3(star) * 0.8;
          col = mix(col, haze, smoothstep(0.06, -0.04, h));
          gl_FragColor = vec4(col * 1.6, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // image-based lighting: the sky itself, prefiltered, so metal and glass
  // have something real to reflect
  {
    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = sky.clone();
    envSky.scale.setScalar(50);
    envScene.add(envSky);
    // a dark ground half so reflections are not sky-bright from below
    const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 16), new THREE.MeshBasicMaterial({ color: 0x25262a }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -1.5;
    envScene.add(floor);
    const tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    scene.environment = pm.fromScene(envScene, 0.02, 0.1, 100).texture;
    renderer.toneMapping = tm;
    scene.environmentIntensity = 0.9;
    pm.dispose();
  }

  const hemi = new THREE.HemisphereLight(0xa9c4ee, 0x4a443e, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffdcb0, 3.4);
  sun.position.copy(sunDir).multiplyScalar(100);
  scene.add(sun);
  scene.add(sun.target);
  const SHADOW_R = 55;
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
    sh.bias = -0.0004; sh.normalBias = 0.05; sh.radius = 2;
  }
  setupShadow();

  // post: bloom on the neon and sun glints, then tone map + a restrained film grade
  let composer = null, bloom = null;
  function setupPost() {
    if (!q.post) { composer = null; return; }
    if (composer) return;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: q.aa ? 4 : 0 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 1.0);
    composer.addPass(bloom);
    composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null }, exposure: { value: 1.0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse; uniform float exposure; varying vec2 vUv;
        vec3 aces(vec3 x) { x *= exposure / 0.6;
          const mat3 a = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
          const mat3 b = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
          x = a * x; vec3 n = x * (x + 0.0245786) - 0.000090537; vec3 d = x * (0.983729 * x + 0.4329510) + 0.238081;
          return clamp(b * (n / d), 0.0, 1.0); }
        void main() {
          vec3 c = aces(texture2D(tDiffuse, vUv).rgb);
          // slight desaturation, cool shadows / warm highlights, vignette
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, 0.92);
          c *= mix(vec3(0.96, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.0, 0.7, l));
          vec2 v = vUv - 0.5; c *= 1.0 - dot(v, v) * 0.42;
          gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
        }`,
    }));
  }
  setupPost();

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
    scene.fog.far = q.far * 0.82;
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

  return { renderer, scene, camera, resize, render, setScale, setQuality, getScale: () => scale, quality: q, sunDir };
}
