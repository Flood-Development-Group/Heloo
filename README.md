# Heloo Vocal Studio

A touch-first singing voice editor for iPad. You draw notes on a piano roll, type lyrics, shape pitch and expression with Apple Pencil or a finger, and Heloo sings them. Everything runs on the device: nothing is uploaded and it works offline once installed.

It is an original app in the vocal-synthesizer genre. It is **not** Synthesizer V Studio, it isn't affiliated with Dreamtonics, and it can't load Synthesizer V voice databases (those are proprietary).

## What it does

- **Piano roll for touch.** Tap with the Pen tool to add notes. Drag a note to move it, or drag its edges to resize it. Drag on empty space with the Select tool to select several notes. Two fingers scroll, and pinch zooms horizontally or vertically. With Apple Pencil, the Pencil edits and one finger scrolls. The rendered pitch curve and each note's phonemes are drawn on the notes.
- **Lyrics.**
  - Double-tap a note and type. Enter moves to the next note, and typing several words fills the following notes. A batch lyrics dialog fills many notes at once.
  - English uses the CMU Pronouncing Dictionary, with spelling rules for unknown words.
  - Japanese accepts kana or romaji.
  - Special lyrics: `+` puts the next syllable of a word on a note, `-` holds the previous vowel, `br` is a breath, and `.hh ah` types phonemes directly. Each note also has a phoneme override.
- **Expression.**
  - Automatic pitch: legato glides with slight preparation and overshoot, an attack scoop after rests, a release fall, and vibrato with delay and fade-in.
  - Per-note vibrato and glide settings, and per-track defaults.
  - Drawable curves for pitch bend, loudness, breathiness, gender, tension and vibrato depth.
- **Voices.**
  - Three built-in voices (Aria, Leo, Kit). They come from an on-device harmonic-plus-noise formant synthesizer.
  - Optional **neural voices**: import an open DiffSinger-format voicebank (the layout OpenUtau uses). It runs locally through ONNX Runtime Web (WebAssembly). See the limitations below.
- **Song tools.**
  - Multiple tracks with mute, solo, volume and pan.
  - Tempo changes and time signature.
  - Loop playback.
  - Undo/redo for every edit.
  - Autosave on the device.
- **Files.** Save/open projects (`.heloo.json`), import/export MIDI with lyrics, and export a stereo 44.1 kHz WAV.
- **Keyboard.** With a Magic Keyboard:

  | Key | Action |
  | --- | --- |
  | Space | Play / stop |
  | ⌘Z, ⇧⌘Z | Undo, redo |
  | V, P, E | Select, Pen, Erase tools |
  | ⌫ | Delete selected notes |
  | ⌘A, ⌘C, ⌘X, ⌘V, ⌘D | Select all, copy, cut, paste, duplicate |
  | ↑ ↓ | Transpose (with ⇧: by an octave) |
  | ← → | Move notes |
  | Enter | Edit lyric |
  | S | Split note |
  | L | Loop |

## Use it on an iPad

Heloo is an installable web app (PWA). It needs to be served over HTTPS once; after that it runs offline.

1. Host the `dist/` folder anywhere static. This repo includes a GitHub Pages workflow (`.github/workflows/pages.yml`). Enable it with *Settings → Pages → Source: GitHub Actions*, then push.
2. Open the URL in Safari on the iPad and tap *Share → Add to Home Screen*.
3. Launch it from the Home Screen. It opens full screen like an app and works offline.

To try it from a computer on the same network, run `npm run dev` and open the printed network address on the iPad. Safari only enables offline mode and installation on HTTPS or localhost.

### Making it a native App Store–style app

The UI and engine are plain web code, so a native shell is a thin wrapper. On a Mac with Xcode, [Capacitor](https://capacitorjs.com) can wrap `dist/` in a `WKWebView` app:

```sh
npm i -D @capacitor/cli @capacitor/core @capacitor/ios
npx cap init Heloo com.example.heloo --web-dir dist
npm run build && npx cap add ios && npx cap open ios
```

This wrapper was **not** built or tested here (it needs macOS and Xcode).

## Development

```sh
npm install
npm run dev        # development server
npm test           # unit tests (Vitest)
npm run typecheck  # TypeScript
npm run build      # production build in dist/
npm run e2e        # build, then drive the app in an emulated iPad (needs Playwright + Chromium)
```

### Code layout

| Path | What it holds |
| --- | --- |
| `src/core/` | Project model, tempo map (480 PPQ), curves, undo history, project files, MIDI, WAV |
| `src/voice/` | Phoneme inventory and the English/Japanese phonemizers |
| `src/engine/` | The renderer (details below) |
| `src/audio/player.ts` | Web Audio playback and mixdown |
| `src/ui/` | Piano roll, parameter lane, inspector, track list, dialogs, app shell |

Inside `src/engine/`:

- `notes.ts` and `plan.ts` split tracks into phrases at rests. Each phrase gets a content hash, so an edit only re-renders the phrases it touches.
- `pitch.ts` holds the pitch model, which is shared by the display and the synthesizer.
- `timing.ts` places phonemes: consonants before the beat, vowels on the beat.
- `acoustic.ts` and `synth.ts` are the built-in voice. Harmonic amplitudes follow a formant envelope and are summed with a Chebyshev recurrence, so the output is band-limited. Aspiration and frication come from filtered noise.
- `worker.ts` and `client.ts` render in a background worker and cache phrase audio on the main thread.
- `neural/` holds the DiffSinger voicebank reader and the ONNX Runtime renderer.

## Neural voicebanks (experimental)

Use *Menu → Import neural voicebank (.zip)*. The zip must contain:

- `dsconfig.yaml` with `acoustic:` and `phonemes:` entries, plus the acoustic `.onnx` model and phoneme list.
- A vocoder folder with `vocoder.yaml` and its `.onnx` (for example NSF-HiFiGAN). OpenUtau often installs the vocoder separately; put it in the zip.
- Optionally, `dsdict.yaml` (or `dsdict-<lang>.yaml`) to map lyrics to the voicebank's phonemes.

Heloo uses its own rules for phoneme timing and its own pitch model. It does not run the voicebank's optional duration, pitch or variance models. If an acoustic model requires energy, breathiness, voicing or tension curves, Heloo approximates them from its own curves.

**What has been verified:** the zip/config/dictionary reader, tokenisation and frame timing, and the ONNX Runtime calls. Unit tests cover them in Node, and the e2e test covers them in the browser build. Both use generated stand-in models that have the DiffSinger input/output interface. **No real voicebank has been tested yet**, so expect rough edges with real models. Model formats vary between DiffSinger versions. Rendering is CPU-only (WebAssembly, single thread), which is slow for large models. Imported voicebanks are kept only for the current session, so re-import after relaunching.

Respect each voicebank's license and terms of use.

## Known limitations

- The built-in voices are a formant synthesizer, not a neural model. They are intelligible and controllable but sound synthetic.
- English letter-to-sound rules for words that aren't in the dictionary are approximate. Use the phoneme override for exact pronunciations.
- Tracks are monophonic: overlapping notes are shortened, and the overlap is marked in red.
- Only one time signature per song.
- In Safari, files are saved through downloads. In the installed Home Screen app, they go through the share sheet.

## Credits

- English pronunciations: [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict) (BSD-style license), via the `cmu-pronouncing-dictionary` package (ISC).
- Neural inference: [ONNX Runtime Web](https://onnxruntime.ai) (MIT).
- Zip: `fflate` (MIT). YAML: `yaml` (ISC).
