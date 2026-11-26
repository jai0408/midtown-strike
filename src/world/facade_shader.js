// Procedural interior-mapping (single-ray parallax rooms) for Midtown building
// facades and street-level storefronts. Zero extra texture fetches, Mali/Adreno
// safe (guarded divisions, no derivatives inside branches), works on Medium & High.
import * as THREE from 'three';

const SAFE_ROOM_GLSL = `
  float fmHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Single-ray interior box raycast in local window space p in [0,1]^2.
  // rayDir = (vx, vy, vz) where +vz points INTO the building, vz >= 0.08.
  // Returns linear interior radiance (emissive + ambient) for the room hit.
  vec3 traceInteriorRoom(vec2 p, vec3 rayDir, vec2 roomId, float isLit, float warmBias, float depthScale) {
    float h0 = fmHash(roomId);
    float h1 = fmHash(roomId + vec2(17.3, 41.7));
    float h2 = fmHash(roomId + vec2(73.1, 11.9));
    float roomD = depthScale * (0.58 + 0.48 * h0);

    float vx = rayDir.x;
    float vy = rayDir.y;
    float vz = max(rayDir.z, 0.08);

    float tx = vx > 0.001 ? (1.0 - p.x) / vx : (vx < -0.001 ? -p.x / vx : 99.0);
    float ty = vy > 0.001 ? (1.0 - p.y) / vy : (vy < -0.001 ? -p.y / vy : 99.0);
    float tz = roomD / vz;

    float tHit = min(min(tx, ty), tz);
    vec3 hit = vec3(clamp(p + vec2(vx, vy) * tHit, 0.0, 1.0), clamp(vz * tHit / max(roomD, 0.1), 0.0, 1.0));

    // Room color temperature: warm apartment/hotel tungsten vs crisp office daylight
    bool warm = h1 < warmBias;
    vec3 lightCol = warm
      ? mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.84, 0.58), h2)
      : mix(vec3(0.76, 0.88, 1.0), vec3(0.92, 0.96, 1.0), h2);

    vec3 wallTint = warm
      ? mix(vec3(0.42, 0.35, 0.28), vec3(0.55, 0.48, 0.38), h0)
      : mix(vec3(0.38, 0.42, 0.48), vec3(0.52, 0.54, 0.58), h0);

    // Corner ambient occlusion inside the 3D room box
    float edgeX = min(hit.x, 1.0 - hit.x);
    float edgeY = min(hit.y, 1.0 - hit.y);
    float edgeZ = 1.0 - hit.z;
    float cornerAO = smoothstep(0.0, 0.24, edgeX + edgeZ * 0.5)
                   * smoothstep(0.0, 0.22, edgeY + edgeZ * 0.5)
                   * (0.58 + 0.42 * (1.0 - hit.z * 0.65));

    vec3 col = wallTint * 0.12;
    if (ty <= tx && ty <= tz) {
      if (vy > 0.0) {
        // Ceiling: recessed fluorescent strips / warm ceiling fixtures
        float sx = abs(fract(hit.x * 2.0) - 0.5);
        float sz = abs(fract(hit.z * 2.0) - 0.5);
        float lamp = (1.0 - smoothstep(0.14, 0.28, sx)) * (1.0 - smoothstep(0.18, 0.34, sz));
        col = wallTint * 0.52 + lightCol * lamp * 1.45;
      } else {
        // Floor: darker carpet/wood catching soft overhead bounce
        col = wallTint * 0.26 * (0.65 + 0.35 * (1.0 - hit.z));
      }
    } else if (tz <= tx && tz <= ty) {
      // Back wall: vertical lamp falloff + subtle desk/shelf silhouette near floor
      float topGrad = 0.52 + 0.48 * smoothstep(0.05, 0.95, hit.y);
      float furn = smoothstep(0.0, 0.04, hit.y - (0.20 + 0.16 * step(0.45, fract(hit.x * 3.0 + h2))));
      float art = (1.0 - smoothstep(0.16, 0.20, abs(hit.x - 0.5))) * (1.0 - smoothstep(0.14, 0.18, abs(hit.y - 0.62)));
      col = wallTint * topGrad * mix(0.45, 1.0, furn) * (1.0 - art * 0.28);
      // Warm wall wash from ceiling fixtures
      col += lightCol * 0.18 * smoothstep(0.35, 1.0, hit.y);
    } else {
      // Side walls: shelving / partition rhythm + gradient
      float rib = 0.85 + 0.15 * sin(hit.z * 18.85 + h0 * 6.28);
      col = wallTint * (0.42 + 0.38 * hit.y) * rib;
    }

    // Lit rooms glow cleanly; unlit rooms still show faint deep dark-blue architectural interior
    float br = isLit > 0.1 ? (0.42 + 0.68 * h2) * isLit : 0.0;
    vec3 litRoom = col * lightCol * br * (0.55 + 0.45 * cornerAO);
    vec3 darkRoom = (wallTint * vec3(0.09, 0.12, 0.17) + vec3(0.015, 0.025, 0.045) * (1.0 - hit.z)) * cornerAO;
    return darkRoom + litRoom;
  }
`;

// Shared uniform controlling interior-parallax cutoff distance per quality preset
// (High/Ultra = 200 m, Medium = 85 m, Low = 0 m).
export const FACADE_PARALLAX_DIST = { value: 190.0 };

/**
 * Patches a building facade MeshStandardMaterial with single-ray interior mapping,
 * per-floor variation, stronger recessed reveal normal relief, and Fresnel glass sheen.
 */
export function applyFacadeParallax(mat, def, idx) {
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.normalScale.set(def.run ? 1.45 : 1.75, def.run ? 1.45 : 1.75);
  mat.onBeforeCompile = (s, renderer) => {
    if (prevCompile) prevCompile(s, renderer);
    s.uniforms.uFacGrid = { value: new THREE.Vector2(def.cols, def.rows) };
    s.uniforms.uFacWarm = { value: def.warm };
    s.uniforms.uFacRun = { value: def.run ? 1.0 : 0.0 };
    s.uniforms.uPxMaxD = FACADE_PARALLAX_DIST;

    const hasWp = s.vertexShader.includes('varying vec3 vWp');
    const hasWn = s.vertexShader.includes('varying vec3 vFacN');
    if (!hasWp || !hasWn) {
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
          ${hasWp ? '' : 'varying vec3 vWp;'}
          ${hasWn ? '' : 'varying vec3 vFacN;'}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          ${hasWp ? '' : 'vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;'}
          ${hasWn ? '' : 'vFacN = normalize(mat3(modelMatrix) * objectNormal);'}`);
    }

    const fragHasWp = s.fragmentShader.includes('varying vec3 vWp');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        ${fragHasWp ? '' : 'varying vec3 vWp;'}
        varying vec3 vFacN;
        uniform vec2 uFacGrid;
        uniform float uFacWarm, uFacRun, uPxMaxD;
        ${SAFE_ROOM_GLSL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // Identify window glass panes from the ORM texture (glass has low roughness & high metalness)
          float isGlass = smoothstep(0.28, 0.14, roughnessFactor) * smoothstep(0.55, 0.78, metalnessFactor);
          // Subtle per-floor architectural tonal variation on masonry/spandrels near street level
          float floorIdx = floor(max(vWp.y, 0.0) / 3.6);
          float flHash = fmHash(vec2(floorIdx, floor(vWp.x * 0.06) + floor(vWp.z * 0.06) * 31.0));
          diffuseColor.rgb *= mix(0.92 + 0.16 * flHash, 1.0, isGlass);

          if (isGlass > 0.02 && uPxMaxD > 1.0) {
            vec3 viewToFrag = vWp - cameraPosition;
            float vDist = length(viewToFrag);
            // Fade interior parallax cleanly beyond uPxMaxD so distant skyline stays crisp and cheap
            float distFade = 1.0 - smoothstep(uPxMaxD * 0.55, uPxMaxD, vDist);
            if (distFade > 0.01) {
              vec3 wn = normalize(vFacN);
              vec3 up = vec3(0.0, 1.0, 0.0);
              vec3 tanU = cross(up, wn);
              float tl = length(tanU);
              tanU = tl > 1e-4 ? tanU / tl : vec3(1.0, 0.0, 0.0);
              vec3 vDir = viewToFrag / max(vDist, 1e-4);
              vec2 gUv = vMapUv * uFacGrid;
              vec2 cellId = floor(gUv) + floor(vWp.xz * 0.05) * 13.0;
              vec2 cellP = fract(gUv);
              vec3 rayLocal = vec3(dot(vDir, tanU), vDir.y, dot(vDir, -wn));
              // Use existing emissive map strength + slight street-level boost as room-lit signal
              float emLum = max(totalEmissiveRadiance.r, max(totalEmissiveRadiance.g, totalEmissiveRadiance.b));
              float roomLit = smoothstep(0.06, 0.45, emLum);
              // Give street-level lower floors a little extra life even on unlit office bays
              float lowFloor = 1.0 - smoothstep(6.0, 28.0, vWp.y);
              float extraLit = step(0.72, fmHash(cellId + vec2(5.1, 9.7))) * lowFloor * 0.55;
              float litAmt = clamp(max(roomLit, extraLit), 0.0, 1.0);
              vec3 room = traceInteriorRoom(cellP, rayLocal, cellId, litAmt, uFacWarm, mix(0.85, 0.68, uFacRun));

              // Fresnel exterior glass reflection blends over the 3D interior
              float NdotV = clamp(dot(wn, -vDir), 0.0, 1.0);
              float fres = 0.06 + 0.94 * pow(max(0.0, 1.0 - NdotV), 4.0);
              float trans = (1.0 - fres * 0.68) * isGlass * distFade;
              totalEmissiveRadiance = mix(totalEmissiveRadiance, room * 1.15, trans);
              diffuseColor.rgb = mix(diffuseColor.rgb, mix(room * 0.35, diffuseColor.rgb * 1.25, fres), isGlass * distFade * 0.7);
            }
          }
        }`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|facpx_${idx}`;
  mat.needsUpdate = true;
  return mat;
}

/**
 * Patches the street-level storefront MeshStandardMaterial with deep shop-window
 * parallax interiors, Fresnel plate-glass reflections, and base contact darkening.
 */
export function applyShopParallax(mat, lightMap, cols, rows) {
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.onBeforeCompile = (s, renderer) => {
    if (prevCompile) prevCompile(s, renderer);
    s.uniforms.uShopGrid = { value: new THREE.Vector2(cols, rows) };
    s.uniforms.uPxMaxD = FACADE_PARALLAX_DIST;
    if (lightMap) {
      s.uniforms.uCityLight = { value: lightMap.texture };
      s.uniforms.uCityRect = { value: lightMap.rect };
    }
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec3 vShopN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvShopN = normalize(mat3(modelMatrix) * objectNormal);');

    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWp;
        varying vec3 vShopN;
        uniform vec2 uShopGrid;
        uniform float uPxMaxD;
        ${lightMap ? 'uniform sampler2D uCityLight;\nuniform vec4 uCityRect;' : ''}
        ${SAFE_ROOM_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // Subtle sidewalk contact darkening at bottom plinth of every storefront
          float plinthAO = mix(0.55, 1.0, smoothstep(0.0, 0.85, max(0.0, vWp.y - 0.15)));
          diffuseColor.rgb *= plinthAO;
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // Open shop glass panes have very low roughness (< 0.22) and high metalness (> 0.65)
          float isGlass = smoothstep(0.24, 0.12, roughnessFactor) * smoothstep(0.55, 0.78, metalnessFactor);
          if (isGlass > 0.02 && uPxMaxD > 1.0) {
            vec3 vToF = vWp - cameraPosition;
            float vDist = length(vToF);
            float distFade = 1.0 - smoothstep(uPxMaxD * 0.45, uPxMaxD * 0.9, vDist);
            if (distFade > 0.01) {
              vec3 wn = normalize(vShopN);
              vec3 vDir = vToF / max(vDist, 1e-4);
              vec3 tanU = cross(vec3(0.0, 1.0, 0.0), wn);
              float tl = length(tanU);
              tanU = tl > 1e-4 ? tanU / tl : vec3(1.0, 0.0, 0.0);
              vec2 gUv = vMapUv * uShopGrid;
              vec2 cellP = fract(gUv);
              vec2 winP = clamp(vec2((cellP.x - 0.04) / 0.92, (cellP.y - 0.08) / 0.68), 0.0, 1.0);
              vec2 shopId = floor(vWp.xz * 0.14) + floor(gUv) * 7.0;
              vec3 rayLocal = vec3(dot(vDir, tanU), vDir.y, dot(vDir, -wn));
              vec3 shopRoom = traceInteriorRoom(winP, rayLocal, shopId, 1.05, 0.72, 1.05);
              float NdotV = clamp(dot(wn, -vDir), 0.0, 1.0);
              float fres = 0.07 + 0.93 * pow(max(0.0, 1.0 - NdotV), 4.0);
              vec3 neonRefl = vec3(0.16, 0.22, 0.34);
              ${lightMap ? `{
                vec2 clUv = (vWp.xz - uCityRect.xy) * uCityRect.zw;
                vec2 clIn = smoothstep(vec2(0.0), vec2(0.06), clUv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - clUv);
                neonRefl += texture2D(uCityLight, clamp(clUv, 0.002, 0.998)).rgb * 1.4 * clIn.x * clIn.y;
              }` : ''}
              vec3 interior = shopRoom * (0.45 + 0.85 * dot(diffuseColor.rgb, vec3(0.35, 0.45, 0.20)));
              totalEmissiveRadiance = mix(totalEmissiveRadiance, interior * (1.0 - fres * 0.55) + neonRefl * fres * 0.65, isGlass * distFade * 0.88);
            }
          }
        }`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|shoppx`;
  mat.needsUpdate = true;
  return mat;
}
