# Midtown Strike — Cedar Lodge & Render Gallery

A comprehensive showcase of the newly enhanced **Cedar Lodge** map featuring:
- **Soaring Mythical Phoenix Bird** (`phoenix_bird.glb`) sweeping across mountain ridges and alpine lake
- **5ft Excavated Natural Koi Pond** with **10 photorealistic Japanese Nishikigoi** (`koi_fish 1.glb`) swimming in clear water with lily pads and river stone coping
- **Authentic Type-C American School Buses** parked between the lodges
- **Vegetation Textures & Physics Overhaul** with traveling wind ripple propagation and player trampling
- **Expansive Mountain Lake** with realistic Fresnel sky reflections, sun specular glints, boathouse, and moored canoes

---

## 🦅 1. Soaring Mythical Phoenix Bird (`phoenix_bird.glb`)

*An ancient mythical Phoenix bird glides across the Cedar Lodge skies. Features a 12m wingspan, iridescent fiery feathers, peacock-crested head, long sweeping tail plumes, continuous skeletal wing flapping physics, dynamic banking into curves, and an ambient warm fiery aura illuminating the alpine landscape.*

````carousel
![Hero Shot: Mythical Phoenix Bird Gliding Over Mountain Lake](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_phoenix.png)
<!-- slide -->
![Phoenix Soaring Overhead Above Cedar Lodge & South Yard](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_south_yard.png)
<!-- slide -->
![Phoenix Soaring in Sky Above School Buses and Cabin](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_buses.png)
````

---

## 🐟 2. The Excavated Natural Koi Pond with 10 Photorealistic 3D Koi Fish (`koi_fish 1.glb`)

*Uneven natural organic perimeter (~8m diameter), 5ft deep excavated gravel basin, 36 river coping stones, crystal-clear water with gentle ripples, floating lily pads with lotus blossoms, and 10 photorealistic Japanese Nishikigoi swimming at various depths with organic spine undulation.*

````carousel
![10 Photorealistic 3D Swimming Koi in Excavated Pond](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_koi_pond.png)
<!-- slide -->
![Downward Perspective into Clear Koi Pond Waters](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/test_10_koi_rendered.png)
````

### The 10 Japanese Koi Varieties in the Pond:
1. **Kohaku**: Pure pearl white with vibrant fire-red patches across head and spine.
2. **Taisho Sanke**: White body with vermilion patches and black sumi ink markings.
3. **Showa Sanshoku**: Midnight black body with bold scarlet and white swirled patterns.
4. **Yamabuki Ogon**: Radiant solid metallic golden-yellow with shimmering golden fins.
5. **Shiro Utsuri**: Jet black with stark white lightning stripes.
6. **Tancho**: Snow white body with a single iconic crimson-red round crest on the head.
7. **Asagi**: Slate blue-grey scaled back with fiery orange-red belly and pectoral fins.
8. **Ki Utsuri**: Jet black body with brilliant golden-yellow markings.
9. **Beni Kumonryu**: Pearl white with flowing black and scarlet patterns.
10. **Kin Matsuba**: Shimmering bronze-gold with dark pinecone scale reticulation.

---

## 🚌 3. Authentic American School Buses Between the Lodges

*Two fully realized, highly detailed Type-C American School Buses parked between the Main Lodge and the Cabin. Features authentic School Bus Yellow paint (`#f5b30c`), front engine cowl / hood with black anti-glare center strip, chrome radiator grille with horizontal slats, dual round chrome-ringed headlights and amber turn signals, heavy-duty black steel bumpers with yellow crossing arm, split slanted windshield with wiper blades, 7 passenger window bays with black divider pillars, right-side passenger bi-fold boarding door with upper and lower glass panes, driver-side red octagonal STOP sign blade, dual side mirrors on tubular brackets, triple black rub rails along both flanks, overhead 'SCHOOL BUS' sign headers with 8-way warning flasher lights, white roof emergency escape hatches, and 6 heavy-duty wheels with rubber tires and steel rims in wheel wells.*

````carousel
![Two School Buses Parked Between the Lodges](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_buses.png)
<!-- slide -->
![School Bus 3/4 Hero Detail Shot](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_bus_detail.png)
<!-- slide -->
![School Bus Ground Test Render](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/test_school_bus.png)
````

---

## 🌲 4. South Yard & Vegetation Overhaul

*View across the South Yard showing the vibrant, deep evergreen pines, lush meadow lawn with traveling wind ripples, player trampling physics, the detailed school buses, natural rock-lined Koi pond, and the Phoenix bird soaring majestically overhead.*

![Cedar Lodge South Yard Overview](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_south_yard.png)

---

## 🏞️ 5. Lakeside Panorama & Lake Water Reflections

*The expansive mountain lake behind Cedar Lodge showing wave ripples, physically-based Fresnel sky reflections, sun specular glints, boathouse on the water, canoes moored at the shore, and alpine water depth gradient.*

![Cedar Lodge Lakefront Panorama](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/lodge_render_lake.png)

---

## 🍃 6. Vegetation Textures & Physics Overhaul Summary

| Feature | Details & Physics Implementation |
| :--- | :--- |
| **Player Trampling Physics** | Grass blades and shrubs dynamically push outward and bend down around the player's boots ($\Delta \vec{x} \propto \frac{\vec{d}}{\|\vec{d}\|}(1 - \frac{d}{R})$) and spring back smoothly. |
| **Pines & Spruces** | Replaced washed-out grey tint with deep alpine conifer needle evergreen (`#365434`, roughness `0.68`) with sun sheen. |
| **Birches & Bushes** | Sunlit olive-gold leaves (`#648a3e`) and dense rich woodland shrub foliage (`#44682e`). |
| **Grass Meadow** | Lush multi-tone meadow grass (`#568c36`), traveling wind wave ripple propagation, and increased blade density. |
| **Bark & Timber** | Deep furrowed normal bump (`normalScale: 1.35`), roughness `0.86`, warm cedar/pine trunk coloration (`#524234`). |
| **Wind Waves** | Global $(0.82, 0.57)$ wind vector with traveling pressure gust fronts sweeping across the forest canopy. |

---

## 🔫 7. Tactical Weapons & Operators

````carousel
![M4 Assault Rifle 3/4 Perspective](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/glb_m4_34.png)
<!-- slide -->
![M4 Assault Rifle First Person ADS](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/glb_m4_fp.png)
<!-- slide -->
![Colt M1911 Pistol](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/glb_m1911_34.png)
<!-- slide -->
![KSR-29 Bolt-Action Sniper Rifle](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/glb_ksr29_34.png)
<!-- slide -->
![Tactical Marine Operator Sheet](/Users/jaikeerthanchowdarybonam/.gemini/antigravity/brain/5a131ece-f3d9-402e-b92b-a8e5e166b65c/images/sheet_soldier.png)
````
