# Credits

Three weapon models and two Cedar Lodge creature models in Midtown Strike come from Sketchfab. All were modified for the game
(decimated, re-baked / resized textures, re-oriented and scaled to true size, attachment points
added) by `tools/blender/import_weapons.py`; the results are embedded in `src/game/weapons_glb.js`.

| In game | Model | Author | Source | Licence | Changes |
|---|---|---|---|---|---|
| M1911 | "Colt M1911" | lokeig | https://sketchfab.com/3d-models/colt-m1911-06a24738a9664466beae2867b917f37c | CC-BY-NC-4.0 | one pistol and its magazine taken from the display scene; modified (decimated, re-baked) |
| KSR-29 | "KSR 29 Sniper" | 3DHaupt | https://sketchfab.com/3d-models/ksr-29-sniper-jEosSrePMDJR9GXwpALOOaRkT3E | CC-BY-NC-4.0 | modified (decimated, re-baked textures) |
| Longsword | "Magic sword." | Biomoloko | https://sketchfab.com/3d-models/magic-sword-2e0ae41235364282b34e735e6161fc16 | CC-BY-4.0 | modified (re-baked textures, emissive map dropped) |
| Koi (Cedar Lodge pond) | "Koi Fish" | 7PLUS | https://sketchfab.com/3d-models/koi-fish-236859b809984f52b70c94fd040b9c59 | CC-BY-4.0 | modified (re-tinted per variety, animated) |
| Phoenix (Cedar Lodge sky) | "phoenix bird" | NORBERTO-3D | https://sketchfab.com/3d-models/phoenix-bird-844ba0cf144a413ea92c779f18912042 | CC-BY-4.0 | modified (scaled, flight path) |
| Soldier (New, v1.6.0) | Procedural Modern Infantry Soldier | Midtown Strike (original) | `tools/build_soldier2_glb.mjs` | CC0 / Project original | procedurally generated mesh (LOD0/LOD1), 2048 PBR maps, 25-bone rig, 23 animations |

Licences: CC-BY-4.0 https://creativecommons.org/licenses/by/4.0/ and CC-BY-NC-4.0
https://creativecommons.org/licenses/by-nc/4.0/.

**CC-BY-NC means non-commercial use only.** The M1911 and KSR-29 models (and therefore any build
containing them) must not be sold, monetised or used commercially; remove or replace them before
any commercial release. The in-game CONTROLS tab carries a short credit line.
