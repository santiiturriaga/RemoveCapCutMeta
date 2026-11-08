# Remove Capcut Metadata

A static, client-side MOV/MP4 metadata cleaner designed for CapCut and other ByteDance exports.

Drop in a video and save a cleaned copy. The app does not upload, decode, transcode, or remux encoded video/audio. It removes only recognized QuickTime CapCut/ByteDance metadata entries, then independently checks the encoded media and codec configuration before offering the output.

## What it removes

The cleaner looks for metadata keys or values containing known CapCut/ByteDance identifiers, including:

- `DreaminaMetaInfo`
- `te_is_reencode`
- `Hw`
- CapCut/ByteDance/Dreamina/Vicut metadata
- CapCut export JSON stored inside `com.apple.quicktime.artwork`

It intentionally keeps ordinary metadata such as creation time, color information, orientation, frame timing, and generic encoder fields.

## Why the output stays visually identical

The video and audio samples are stored in the `mdat` atom. This project never changes that atom and never invokes a codec. It completely removes matching entries from indexed QuickTime metadata (including their keys), re-numbers any surviving item indices, and rebuilds valid metadata boxes. The released space is placed in a standard free box at the OUTER movie level. This keeps the movie's total size and all media chunk offsets unchanged without leaving empty/malformed metadata items behind. Unrelated metadata, codec/sample tables and encoded video/audio are untouched.

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
- On iPhone and iPad, the Save button opens the original native share sheet when file sharing is supported, with a byte-preserving browser-download fallback.
- Select the source video using Files, not Photo Library: iOS may give the browser an SDR-compatible derivative when choosing a Photos video. The site cannot restore HDR absent from the input. Choose Photos Share > Options > Current (avoid conversion), then Save to Files if needed.
- The page reports the file size **as received by the browser**, the cleaned output size, and whether its parsed container color signaling is HDR, SDR or inconclusive. HEVC HDR signaling inside the bitstream can be present even when the container lacks an explicit color atom.
- Before enabling Save, the page independently compares every encoded video/audio payload byte and every track's codec sample description with the selected browser input. Large media payloads are compared in bounded-memory chunks.
- After saving, the **Verify saved video's HDR and media bytes** option compares a selected copy from Files against the original browser input. It identifies whether the encoded media or HDR/codec boxes changed after using iOS's share sheet.
- The usual native iPhone share sheet remains the primary button; an optional exact-blob download is available to bypass any receiver-side transformation.
- Very large videos still require enough browser memory to read the movie metadata atom; full-video comparisons use 1 MiB chunks and never decode the frames.

## Verification

Run: node --test tests/*.test.mjs

The suite checks valid metadata-box rewriting, selective identifier removal, native sharing, browser-side integrity verification, and preservation of the original
encoded mdat payload and codec/sample-description bytes across PQ, HLG,
Dolby Vision, SDR, and files with unknown HDR signaling.

For a real generated 10-bit HEVC HLG test video, FFprobe reported the same BT.2020 primaries,
BT.2020 non-constant-luminance matrix, and HLG (arib-std-b67) transfer
function before and after cleaning. Both files had the same byte length and
the same SHA-256 of their entire mdat payload. Decoded frame hashes matched as well. FFprobe no longer reported the CapCut metadata key or the malformed cover-art warning that the earlier placeholder method left behind.

The browser cannot control changes made by the operating system while importing
a video from Photos or by an app receiving a file through the share sheet.
For byte-exact checks, select the source video from Files and compare the
downloaded file, not a copy re-exported by another app.

## Limitations

The app removes known identifiers found in the file container. A platform may use other signals such as account linkage, upload workflow, visual matching, or unknown metadata fields, so removal of a specific platform button cannot be guaranteed.

## License

MIT
