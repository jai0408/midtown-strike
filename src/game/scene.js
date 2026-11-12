// Renderer, sky, fog and lighting: a blue-hour Manhattan with the sunset glow
// lined up with the cross streets.
import * as THREE from 'three';
import { setMaxAnisotropy } from '../world/textures.js';

export const QUALITY = {
  low: { height: 540, draw: 0.7, far: 900, aa: false },
  medium: { height: 720, draw: 1.0, far: 1300, aa: false },
  high: { height: 1080, draw: 1.25, far: 1700, aa: true },
};

export function createScene(canvas, qualityName = 'medium') {
  const q = { ...(QUALITY[qualityName] || QUALITY.medium) };
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: q.aa, alpha: false, stencil: false, powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x1a1630);
  renderer.info.autoReset = true;
  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const FOG = 0x3a2f55;
  scene.fog = new THREE.Fog(FOG, 90, q.far * 0.82);

  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.12, q.far);
  camera.rotation.order = 'YXZ';

  // sky dome
  const sunDir = new THREE.Vector3(-0.96, 0.1, 0.26).normalize();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x070b24) },
        mid: { value: new THREE.Color(0x2a2a6e) },
        horizon: { value: new THREE.Color(0x8a4a7a) },
        haze: { value: new THREE.Color(FOG) },
        sunDir: { value: sunDir },
        sunCol: { value: new THREE.Color(0xff8a3c) },
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
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0x93a4ff, 0x6a5560, 2.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffa066, 1.7);
  sun.position.copy(sunDir).multiplyScalar(100).add(new THREE.Vector3(0, 28, 0));
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x7f9cff, 0.55);
  fill.position.set(60, 80, -40);
  scene.add(fill);

  let w = 0, h = 0, scale = 1;
  function resize(force) {
    const cw = canvas.clientWidth || window.innerWidth, ch = canvas.clientHeight || window.innerHeight;
    if (!force && cw === w && ch === h) return;
    w = cw; h = ch;
    const dpr = window.devicePixelRatio || 1;
    const ratio = Math.min(dpr, Math.max(0.35, (q.height / Math.max(1, Math.min(cw, ch))) * scale));
    renderer.setPixelRatio(ratio);
    renderer.setSize(cw, ch, false);
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
    q.height = n.height; q.draw = n.draw; q.far = n.far;
    camera.far = q.far;
    scene.fog.far = q.far * 0.82;
    camera.updateProjectionMatrix();
    scale = 1;
    resize(true);
  }

  function render() {
    sky.position.copy(camera.position);
    sky.scale.setScalar(camera.far * 0.9);
    renderer.render(scene, camera);
  }

  return { renderer, scene, camera, resize, render, setScale, setQuality, getScale: () => scale, quality: q, sunDir };
}
