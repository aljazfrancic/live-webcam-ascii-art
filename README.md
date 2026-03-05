# Live Webcam ASCII Art

Real-time webcam feed converted to ASCII art, running entirely in the browser with zero dependencies.

**[Live Demo](https://aljazfrancic.github.io/live-webcam-ascii-art/)**

## Features

- Real-time webcam-to-ASCII conversion at ~20 FPS
- Adjustable resolution (character grid density)
- Adjustable font size
- Multiple character ramp presets (simple, standard, detailed, blocks)
- Color mode — ASCII characters tinted with original pixel colors
- Invert brightness mapping
- Screenshot — download the current ASCII frame as a PNG

## Usage

1. Open the app in a modern browser (Chrome, Firefox, Edge).
2. Click **Start Camera** and grant webcam permission.
3. Tweak controls: resolution, font size, character ramp, color mode, and invert.
4. Click **Screenshot** to save the current frame.

## Deployment

This is a static site with no build step. To deploy on GitHub Pages:

1. Push to the `main` branch.
2. In the repo settings, go to **Pages** and set the source to the `main` branch, root `/`.
3. The site will be live at `https://<username>.github.io/live-webcam-ascii-art/`.

## License

[MIT](LICENSE)
