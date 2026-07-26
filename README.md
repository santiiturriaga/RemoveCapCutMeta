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
- iPhone and iPad use the file picker. The Save button uses the system share sheet when file sharing is available, otherwise it downloads the file.
- Very large videos still require enough browser memory to read the movie metadata atom, but the app does not load or copy the full media payload into JavaScript memory.

## Verification performed on the supplied sample

The test output remained `.mov`. Extracted HEVC video and AAC audio hashes matched the original exactly. The original 10-bit BT.2020 HLG and Dolby Vision configuration remained present, while these four entries were removed:

- `com.apple.quicktime.artwork` containing CapCut/Vicut export JSON
- `Hw`
- `te_is_reencode`
- `DreaminaMetaInfo`

## Limitations

The app removes known identifiers found in the file container. A platform may use other signals such as account linkage, upload workflow, visual matching, or unknown metadata fields, so removal of a specific platform button cannot be guaranteed.

## License

MIT
