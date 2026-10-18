# Timeline Explorer

An interactive explorer and travel-video maker for your Google Maps Timeline export.
It runs entirely in your browser. Your location file is never uploaded anywhere.

Inspired by and built on what we learned from
[mahlernim/google-timeline-visualizer](https://github.com/mahlernim/google-timeline-visualizer).

## What's different

| | Original | Timeline Explorer |
|---|---|---|
| Camera | Zooms out as the route grows and rarely comes back | **Zooms out before you travel and back in once you arrive**, smoothly in both directions |
| Pacing | By distance only, so days spent in one city flash by | A **story clock** that mixes elapsed time and movement, and gives every flight a minimum on-screen time |
| Exploring | Preview only | **Interactive map** (pan and zoom freely) plus a **zoomable timeline** you can brush, scrub and play |
| Context | Coordinates | **Offline city names** (GeoNames), auto-detected **trips**, top places, countries and flights |
| Flights | Straight jumps | Curved dashed arcs with a plane marker and a "Delhi → Mumbai" label |
| Video | Fixed overlay | Live **WYSIWYG preview frame**, landscape/portrait/square, 720p/1080p, 30/60 fps, intro and ending summary |

### How the auto-zoom camera works

At every moment the camera frames everything you do in the next and previous
~2 seconds of video (`windowSec`):

- **In a city** that window holds only your local movement, so the camera zooms in
  (up to "Closest zoom", 13 by default, roughly a city district).
- **Around a flight or a long drive** the window holds both the origin and the destination,
  so the camera starts zooming out *before* departure and settles back in *after* arrival.

Zoom goes through a min-filter (so fast travel is never cropped) and a symmetric Gaussian
filter (so zooming in is as smooth as zooming out). The marker is always kept inside the area
not covered by the overlay. See `src/camera.ts`.

## Use it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (parsing, story clock, camera, trips)
npm run build      # static site in dist/ – host anywhere
```

1. Export your Timeline:
   - **Android:** Settings → Location → Location services → Timeline → Export Timeline data.
   - **iPhone:** Google Maps → profile → Settings → Personal content → Export Timeline data.
2. Drop `Timeline.json` on the page. Older Takeout `Records.json` and Semantic Location History
   files also work, and you can select several at once.
3. **Explore:**
   - Drag on the timeline to select dates, or click a bar to select that day or trip.
   - Wheel over the timeline to zoom it; shift-drag to pan.
   - Press ▶ (or Space) to play. With **Auto camera** on, the map follows the journey.
     Touch the map and you are in control again; tick the box to hand control back.
   - ← / → step through the journey (hold Shift for bigger steps).
4. **Make a video:**
   - Open the **Video** tab, or press 🎬 on a trip.
   - The map shows the exact video frame and overlay. Preview it, then select **Create MP4**.
   - Frames are rendered one by one after the map tiles finish loading, so the video stays
     smooth whatever your connection speed. Keep the tab visible while it renders.

MP4 export needs WebCodecs: current Chrome or Edge, Safari 16.4+, or Firefox 130+.

## Settings worth knowing

- **Camera:** *Close* zooms in and out more often; *Calm* holds wider views.
- **Closest zoom in a city:** 11 ≈ a whole metro area, 13 ≈ a district, 15 ≈ streets.
- **Pacing:** *by time* gives more video time to long stays; *by movement* gives more to
  days with a lot of travel.

## Project layout

```
src/parse.ts         all export formats → one clean, time-sorted point set (+ spike filter)
src/journey.ts       selection → story clock, flight arcs, positions
src/camera.ts        auto-zoom camera track, intro/outro, zoom-around-a-point blending
src/analysis.ts      days, home detection, trips, time per city
src/places.ts        offline nearest-city lookup
src/overlay.ts       route, comet tail, marker and HUD drawing (shared by preview and export)
src/exporter.ts      frame-by-frame MP4 rendering (MapLibre + mediabunny)
src/timeline-bar.ts  the zoomable histogram timeline
src/main.ts          UI wiring
```

`public/cities.json` is generated from GeoNames `cities15000`:
`npm run build:cities -- /path/to/cities15000.txt`.

## Privacy

Your Timeline file is read and processed inside your browser and is never uploaded.
Basemap tiles come from CARTO or OpenFreeMap, which can see which map areas you view.
`.gitignore` excludes `Timeline*.json` so personal exports are never committed.

## Credits

- Map data © OpenStreetMap contributors. Basemaps © CARTO and OpenFreeMap.
- City names from [GeoNames](https://www.geonames.org/) (CC BY 4.0).
- Rendering with [MapLibre GL JS](https://maplibre.org/); MP4 encoding with [mediabunny](https://mediabunny.dev/).
