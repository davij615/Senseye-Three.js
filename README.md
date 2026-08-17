# Senseye — Landing Page with Live Ocular Scan

A static landing page for Senseye's ocular biomarker diagnostics, with the eye
footage as a seamless looping background and an interactive scan animation
(reticle lock → iris digitization → biomarker analysis → complete) anchored to
the eye in the video. Click **Run Ocular Scan** (bottom right) to trigger it.

## Structure

```
index.html          page markup (import map for Three.js CDN)
css/style.css       layout + HUD styles
js/main.js          engine loader (WebGL check + fallback)
js/scan3d.js        Three.js engine: video-as-texture, shader grade,
                    GPU digit cloud, UnrealBloom, camera dolly/parallax
js/scan.js          Canvas2D fallback engine (auto-used if WebGL or the
                    CDN is unavailable)
js/track-data.js    per-frame eye track: center, radii, and 64-angle polar
                    CONTOURS of the real pupil + iris edges
assets/eye-loop.mp4 background footage (boomerang loop, seamless)
```

No build step. Three.js (v0.170) loads from the jsDelivr CDN via an import
map; nothing to install.

## Run locally

Any static server works:

```
npx serve .
# or
python3 -m http.server 8000
```

Then open http://localhost:8000 (opening index.html directly also works).

## Deploy

1. Push this folder to a GitHub repo:

   ```
   git init
   git add .
   git commit -m "Senseye landing page"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/senseye-site.git
   git push -u origin main
   ```

2. On [vercel.com](https://vercel.com): **Add New → Project**, import the repo,
   leave the framework preset as **Other** (it's a static site), and deploy.
   No configuration needed.

## Notes

- The scan **traces the real anatomical edges**: at lock-on the actual pupil
  contour draws itself on (starting from the top), followed by the actual iris
  (limbus) contour. Both are 64-point polar profiles extracted per frame from
  the footage (pupil from the dark-blob contour; iris from radial limbus
  gradients, with eyelid-occluded angles filled by an ellipse fit), so they are
  genuinely non-circular and deform, dilate, and move with the eye throughout
  the scan.
- The scan overlay tracks the eye **live during playback**: `js/track-data.js`
  holds per-frame pupil/iris measurements from the source footage, and the
  overlay samples them against `video.currentTime` every animation frame
  (folding the boomerang loop back to source frames, interpolating between
  frames, and mapping through the `object-fit: cover` transform). The reticle,
  orbits, and pulses follow eye movement, and pupil-anchored elements plus the
  "Pupil diameter" HUD metric breathe with the real dilation in the footage.
- `prefers-reduced-motion` is respected: the scan jumps to its completed state.
- To adjust scan pacing, edit the `T_ACQ0 / T_ACQ1 / T_SWP1 / T_ANL1 / T_HOLD`
  constants (mirrored in `js/scan3d.js` and `js/scan.js`).
- Bloom look lives in `js/scan3d.js` (`UnrealBloomPass(strength, radius,
  threshold)` — currently `0.85, 0.55, 0.88`). Raise the threshold if skin
  highlights bloom too much on bright footage.
- The WebGL engine renders the video *inside* the scene as a texture, so the
  DOM `<video>` is hidden (`.frame.webgl #bgvid`) but keeps playing as the
  texture source and the tracking clock.
