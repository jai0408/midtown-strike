// Car / bus paint: the baked albedo has strong dirt blotches that read as camouflage at game distances.
// Blend it toward a blurred sample of itself (texture bias picks a coarse mip) so the colour stays, the speckle goes.
export function smoothPaint(m, blur = 0.62) {
  if (!m.map || m.userData.smoothPaint) return;
  m.userData.smoothPaint = true;
  m.customProgramCacheKey = () => `paint-smooth-${blur}`;
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 pSharp = texture2D(map, vMapUv);
        vec4 pSoft = texture2D(map, vMapUv, 5.0);
        diffuseColor *= mix(pSharp, pSoft, ${blur.toFixed(2)});
      #endif`);
  };
  m.needsUpdate = true;
}
