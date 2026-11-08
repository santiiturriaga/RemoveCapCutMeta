# Remove Capcut Metadata

A static, client-side MOV/MP4 metadata cleaner designed for CapCut and other ByteDance exports.

Drop in a video and save a cleaned copy. The app does not upload, decode, transcode, or remux the media. It edits only matching QuickTime metadata atoms and keeps every other byte in place.

## What it removes

The cleaner looks for metadata keys or values containing known CapCut/ByteDance identifiers, including:

- `DreaminaMetaInfo`
- `te_is_reencode`
- `Hw`
- CapCut/ByteDance/Dreamina/Vicut metadata
- CapCut export JSON stored inside `com.apple.quicktime.artwork`

It intentionally keeps ordinary metadata such as creation time, color information, orientation, frame timing, and generic encoder fields.

## Why the output stays visually identical

The video and audio samples are stored in the `mdat` atom. This project never changes that atom and never invokes a codec. It rewrites only matching entries in metadata atoms, pads the removed space with a valid `free` atom, and preserves the original file size and all offsets.

That also leaves HDR, HLG, Dolby Vision configuration, audio, frame rate, resolution, and compression untouched.

## Run locally

Because the project is static, any basic web server works:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

Opening `index.html` directly may work in some browsers, but a local server is recommended because the JavaScript uses ES modules.

## Browser notes

- Desktop browsers support drag and drop.
- iPhone and iPad use the file picker. The Save button downloads the exact generated MP4/MOV bytes instead of invoking the share sheet, where a receiving app might transform the asset.
- Very large videos still require enough browser memory to read the movie metadata atom, but the app does not load or copy the full media payload into JavaScript memory.

## Verification

Run: node --test tests/hdr-safe.test.mjs

The suite checks selective metadata removal and preservation of the original
encoded mdat payload and codec/sample-description bytes across PQ, HLG,
Dolby Vision, SDR, and files with unknown HDR signaling.

For a real 10-bit HEVC HLG test video, FFprobe reported the same BT.2020 primaries,
BT.2020 non-constant-luminance matrix, and HLG (arib-std-b67) transfer
function before and after cleaning. Both files had the same byte length and
the same SHA-256 of their entire mdat payload.

The browser cannot control changes made by the operating system while importing
a video from Photos or by an app receiving a file through the share sheet.
For byte-exact checks, select the source video from Files and compare the
downloaded file, not a copy re-exported by another app.

## Limitations

The app removes known identifiers found in the file container. A platform may use other signals such as account linkage, upload workflow, visual matching, or unknown metadata fields, so removal of a specific platform button cannot be guaranteed.

## License

MIT
