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

Use *Menu → Import neural voicebank (.zip)* to add a DiffSinger voicebank in the layout OpenUtau uses. Heloo reads:

- **`dsconfig.yaml`:** must name the acoustic `.onnx` model and the phoneme list (`phonemes.txt` or `.json`).
- **Dictionary:** `dsdict.yaml` / `dsdict-<lang>.yaml`, or plain-text `dsdict.txt` / `dictionary.txt`. If neither is at the top level, it uses the `dsdict.yaml` inside the `dsdur` / `dspitch` / `dsvariance` folders. Lyrics are looked up in the voicebank's own dictionary first, so a Mandarin voicebank takes pinyin lyrics such as `ni`, `hao`.
- **Variance model** (optional, `dsvariance`): when the acoustic model needs energy or breathiness curves, Heloo runs the voicebank's variance model to predict them. If there's no variance model, it approximates them, staying silent during rests.
- **Vocoder:** voicebanks usually rely on a separately installed vocoder such as NSF-HiFiGAN. If yours has none, Heloo asks you to import one (an OpenUtau `.oudep` package or a `.zip` containing `vocoder.yaml` and its `.onnx`). You can also use *Menu → Import vocoder*. If the name in `dsconfig` doesn't match, Heloo uses a vocoder with the same sample rate, hop size and mel bins.

Heloo uses its own timing rules and pitch model. It doesn't run a voicebank's duration (`dsdur`) or pitch (`dspitch`) models.

**Tested with real voicebanks** (November 2026):

| Voicebank | Language | Licence | Notes |
| --- | --- | --- | --- |
| `opencpopJPN` | Mandarin | MIT repo, Opencpop data | Acoustic model only |
| `白溺 (Baini) DiffSinger Lite 0.1` | Mandarin | CC BY-NC 4.0, no redistribution | Also has duration, pitch and variance models |

The vocoder was OpenVPI's PC-NSF-HiFiGAN 2025.02 (CC BY-NC-SA 4.0).

What was checked:

- Both voicebanks load and render in Node and in the browser build.
- On a four-note pinyin phrase, every note was within 20 cents of the written pitch.
- Rests stay silent.
- The piano roll shows the voicebank's phonemes.
- The browser test also covers the vocoder prompt and WAV export.

The audio quality wasn't judged by ear.

**Performance:** ONNX Runtime Web runs on the CPU (WebAssembly, one thread). Loading a voicebank takes about 10–20 s, and rendering is about 10× slower than real time: around 25 s for a 2.6 s phrase in this test environment. iPads may be faster or slower than that.

Imported voicebanks and vocoders last only for the current session. Respect each voicebank's terms: most are non-commercial, require credit, and forbid redistribution. Don't host them with the app.

### Testing with your own voicebanks

```sh
# Node: every *.zip in the folder, plus a vocoder folder or .oudep inside it
HELOO_VOICEBANK_DIR=/path/to/voicebanks npx vitest run tests/real-voicebank.test.ts
# Browser (build first)
npm run build && HELOO_VOICEBANK=/path/vb.zip HELOO_VOCODER=/path/vocoder.oudep node e2e/real-voicebank.mjs
```

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
