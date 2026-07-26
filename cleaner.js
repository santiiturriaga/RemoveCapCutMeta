const textDecoder = new TextDecoder("utf-8", { fatal: false });

const MARKERS = [
  "capcut",
  "bytedance",
  "dreamina",
  "vicut",
  "te_is_reencode",
  "com.lemon.lvoverseas",
  "lvoverseas"
];

const USER_METADATA_CONTAINERS = new Set(["meta", "udta"]);

function readU16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, false);
}

function readU32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function writeU32(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, false);
}

function readU64(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const value = view.getBigUint64(0, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("This file is too large for safe browser processing.");
  }
  return Number(value);
}

function writeZero(bytes, start, length) {
  bytes.fill(0, start, start + length);
}

function fourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function writeType(bytes, offset, type) {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = type.charCodeAt(index);
}

function parseBoxes(bytes, start, end) {
  const boxes = [];
  let position = start;

  while (position + 8 <= end) {
    let size = readU32(bytes, position);
    const type = fourCC(bytes, position + 4);
    let headerSize = 8;

    if (size === 1) {
      if (position + 16 > end) break;
      size = readU64(bytes, position + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - position;
    }

    if (size < headerSize || position + size > end) break;
    boxes.push({ position, size, type, headerSize });
    position += size;
  }

  return boxes;
}

function isPlausibleType(bytes, offset) {
  if (offset + 4 > bytes.length) return false;
  for (let index = 0; index < 4; index += 1) {
    const value = bytes[offset + index];
    if (!((value >= 32 && value <= 126) || value >= 160)) return false;
  }
  return true;
}

function metaChildrenStart(metaBytes) {
  if (metaBytes.length < 16) return 8;
  const candidateSize = readU32(metaBytes, 8);
  const looksLikeChild = candidateSize >= 8
    && candidateSize <= metaBytes.length - 8
    && isPlausibleType(metaBytes, 12);
  return looksLikeChild ? 8 : 12;
}

function printableText(bytes) {
  return textDecoder.decode(bytes).replace(/\0/g, "").trim();
}

function extractDataValue(payload) {
  const children = parseBoxes(payload, 0, payload.length);
  const data = children.find((box) => box.type === "data");
  if (!data) return printableText(payload);
  const valueStart = data.position + data.headerSize + 8;
  return printableText(payload.slice(Math.min(valueStart, data.position + data.size), data.position + data.size));
}

function parseMetaEntries(metaBytes, path) {
  if (metaBytes.length < 16 || fourCC(metaBytes, 4) !== "meta") return [];

  const childStart = metaChildrenStart(metaBytes);
  const children = parseBoxes(metaBytes, childStart, metaBytes.length);
  const keysBox = children.find((box) => box.type === "keys");
  const ilstBox = children.find((box) => box.type === "ilst");
  if (!keysBox || !ilstBox) return [];

  const keysPayloadStart = keysBox.position + keysBox.headerSize;
  const keysPayloadEnd = keysBox.position + keysBox.size;
  if (keysPayloadEnd - keysPayloadStart < 8) return [];

  const keyCount = readU32(metaBytes, keysPayloadStart + 4);
  const keys = [];
  let keyPosition = keysPayloadStart + 8;

  for (let index = 0; index < keyCount; index += 1) {
    if (keyPosition + 8 > keysPayloadEnd) break;
    const keySize = readU32(metaBytes, keyPosition);
    if (keySize < 8 || keyPosition + keySize > keysPayloadEnd) break;
    keys.push(textDecoder.decode(metaBytes.slice(keyPosition + 8, keyPosition + keySize)));
    keyPosition += keySize;
  }

  const values = new Map();
  for (const entry of parseBoxes(metaBytes, ilstBox.position + ilstBox.headerSize, ilstBox.position + ilstBox.size)) {
    const index = readU32(metaBytes, entry.position + 4);
    const payload = metaBytes.slice(entry.position + entry.headerSize, entry.position + entry.size);
    values.set(index, extractDataValue(payload));
  }

  return keys.map((key, index) => ({
    key,
    value: values.get(index + 1) ?? "",
    path,
    kind: "metadata"
  }));
}

function parseUdtaEntries(udtaBytes, path) {
  if (udtaBytes.length < 8 || fourCC(udtaBytes, 4) !== "udta") return [];
  const result = [];

  for (const child of parseBoxes(udtaBytes, 8, udtaBytes.length)) {
    if (child.type === "meta") {
      result.push(...parseMetaEntries(udtaBytes.slice(child.position, child.position + child.size), `${path}/meta`));
      continue;
    }

    const value = printableText(udtaBytes.slice(child.position + child.headerSize, child.position + child.size));
    result.push({
      key: child.type,
      value,
      path,
      kind: "user-data"
    });
  }

  return result;
}

function parseTimestamp(bytes, box, label, path) {
  if (box.size < 20) return [];
  const version = bytes[box.position + box.headerSize];
  const creationOffset = box.position + box.headerSize + 4;
  const modificationOffset = version === 1 ? creationOffset + 8 : creationOffset + 4;
  const creation = version === 1 ? readU64(bytes, creationOffset) : readU32(bytes, creationOffset);
  const modification = version === 1 ? readU64(bytes, modificationOffset) : readU32(bytes, modificationOffset);
  const entries = [];

  if (creation !== 0) entries.push({ key: `${label} creation time`, value: quickTimeDate(creation), path, kind: "timestamp" });
  if (modification !== 0 && modification !== creation) {
    entries.push({ key: `${label} modification time`, value: quickTimeDate(modification), path, kind: "timestamp" });
  }
  return entries;
}

function quickTimeDate(seconds) {
  const unixSeconds = seconds - 2082844800;
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime()) ? String(seconds) : date.toISOString();
}

function clearTimestamps(bytes, box) {
  if (box.size < 20) return false;
  const version = bytes[box.position + box.headerSize];
  const creationOffset = box.position + box.headerSize + 4;
  const fieldLength = version === 1 ? 8 : 4;
  const modificationOffset = creationOffset + fieldLength;
  let changed = false;

  for (let index = creationOffset; index < modificationOffset + fieldLength; index += 1) {
    if (bytes[index] !== 0) changed = true;
  }

  writeZero(bytes, creationOffset, fieldLength * 2);
  return changed;
}

function replaceWithFree(bytes, box) {
  if (box.size < 8 || box.size > 0xffffffff) return false;
  bytes.fill(0, box.position, box.position + box.size);
  writeU32(bytes, box.position, box.size);
  writeType(bytes, box.position + 4, "free");
  return true;
}

function parseMvhdDuration(bytes, box) {
  const version = bytes[box.position + box.headerSize];
  const base = box.position + box.headerSize;
  const timescaleOffset = version === 1 ? base + 20 : base + 12;
  const durationOffset = version === 1 ? base + 24 : base + 16;
  if (durationOffset + (version === 1 ? 8 : 4) > box.position + box.size) return null;
  const timescale = readU32(bytes, timescaleOffset);
  const duration = version === 1 ? readU64(bytes, durationOffset) : readU32(bytes, durationOffset);
  return timescale > 0 ? duration / timescale : null;
}

function parseTkhdDimensions(bytes, box) {
  if (box.size < 16) return null;
  const widthRaw = readU32(bytes, box.position + box.size - 8);
  const heightRaw = readU32(bytes, box.position + box.size - 4);
  const width = widthRaw / 65536;
  const height = heightRaw / 65536;
  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null;
}

function findChild(bytes, parent, type, childStart = parent.position + parent.headerSize) {
  return parseBoxes(bytes, childStart, parent.position + parent.size).find((box) => box.type === type) ?? null;
}

function parseHandlerType(bytes, mdia) {
  const hdlr = findChild(bytes, mdia, "hdlr");
  if (!hdlr || hdlr.size < 20) return null;
  return fourCC(bytes, hdlr.position + hdlr.headerSize + 8);
}

function findNested(bytes, parent, path) {
  let current = parent;
  for (const type of path) {
    current = findChild(bytes, current, type);
    if (!current) return null;
  }
  return current;
}

function parseDolbyVision(bytes, box) {
  const start = box.position + box.headerSize;
  if (box.size - box.headerSize < 5) return null;
  const profile = (bytes[start + 2] >> 1) & 0x7f;
  const level = ((bytes[start + 2] & 0x01) << 5) | (bytes[start + 3] >> 3);
  const compatibilityId = bytes[start + 4] >> 4;
  return {
    profile,
    level,
    compatibilityId,
    rpuPresent: Boolean(bytes[start + 3] & 0x04),
    enhancementLayerPresent: Boolean(bytes[start + 3] & 0x02),
    baseLayerPresent: Boolean(bytes[start + 3] & 0x01)
  };
}

function parseHvcC(bytes, box) {
  const start = box.position + box.headerSize;
  if (box.size - box.headerSize < 19) return {};
  return {
    bitDepth: 8 + (bytes[start + 17] & 0x07),
    chromaFormat: bytes[start + 16] & 0x03
  };
}

function parseSampleEntry(bytes, stsd, handlerType) {
  const entriesStart = stsd.position + stsd.headerSize + 8;
  const entries = parseBoxes(bytes, entriesStart, stsd.position + stsd.size);
  const entry = entries[0];
  if (!entry) return {};

  const result = { codec: entry.type };
  let childStart = entry.position + entry.headerSize;
  if (handlerType === "vide") childStart += 78;
  if (handlerType === "soun") childStart += 28;
  if (childStart > entry.position + entry.size) return result;

  for (const child of parseBoxes(bytes, childStart, entry.position + entry.size)) {
    if (child.type === "hvcC") Object.assign(result, parseHvcC(bytes, child));
    if (child.type === "dvvC" || child.type === "dvcC") result.dolbyVision = parseDolbyVision(bytes, child);
  }

  return result;
}

function analyzeTrack(bytes, trak, index) {
  const tkhd = findChild(bytes, trak, "tkhd");
  const mdia = findChild(bytes, trak, "mdia");
  if (!mdia) return null;
  const handlerType = parseHandlerType(bytes, mdia);
  const stsd = findNested(bytes, mdia, ["minf", "stbl", "stsd"]);
  const sample = stsd ? parseSampleEntry(bytes, stsd, handlerType) : {};

  return {
    index,
    type: handlerType,
    dimensions: tkhd ? parseTkhdDimensions(bytes, tkhd) : null,
    ...sample
  };
}

function analyzeMoov(bytes) {
  const children = parseBoxes(bytes, 8, bytes.length);
  const metadata = [];
  const tracks = [];
  let duration = null;

  for (const child of children) {
    if (child.type === "mvhd") {
      duration = parseMvhdDuration(bytes, child);
      metadata.push(...parseTimestamp(bytes, child, "Movie", "moov/mvhd"));
    } else if (child.type === "meta") {
      metadata.push(...parseMetaEntries(bytes.slice(child.position, child.position + child.size), "moov/meta"));
    } else if (child.type === "udta") {
      metadata.push(...parseUdtaEntries(bytes.slice(child.position, child.position + child.size), "moov/udta"));
    } else if (child.type === "trak") {
      const track = analyzeTrack(bytes, child, tracks.length);
      if (track) tracks.push(track);
      const tkhd = findChild(bytes, child, "tkhd");
      if (tkhd) metadata.push(...parseTimestamp(bytes, tkhd, `Track ${tracks.length}`, `moov/trak[${tracks.length - 1}]/tkhd`));
      const mdia = findChild(bytes, child, "mdia");
      if (mdia) {
        const mdhd = findChild(bytes, mdia, "mdhd");
        if (mdhd) metadata.push(...parseTimestamp(bytes, mdhd, `Track ${tracks.length} media`, `moov/trak[${tracks.length - 1}]/mdhd`));
        for (const nested of parseBoxes(bytes, mdia.position + mdia.headerSize, mdia.position + mdia.size)) {
          if (nested.type === "meta") metadata.push(...parseMetaEntries(bytes.slice(nested.position, nested.position + nested.size), "moov/trak/mdia/meta"));
          if (nested.type === "udta") metadata.push(...parseUdtaEntries(bytes.slice(nested.position, nested.position + nested.size), "moov/trak/mdia/udta"));
        }
      }
      for (const nested of parseBoxes(bytes, child.position + child.headerSize, child.position + child.size)) {
        if (nested.type === "meta") metadata.push(...parseMetaEntries(bytes.slice(nested.position, nested.position + nested.size), "moov/trak/meta"));
        if (nested.type === "udta") metadata.push(...parseUdtaEntries(bytes.slice(nested.position, nested.position + nested.size), "moov/trak/udta"));
      }
    }
  }

  return { duration, tracks, metadata };
}

function scrubTrack(bytes, trak, removedContainers) {
  let changed = false;
  const children = parseBoxes(bytes, trak.position + trak.headerSize, trak.position + trak.size);

  for (const child of children) {
    if (child.type === "tkhd") changed = clearTimestamps(bytes, child) || changed;
    if (child.type === "uuid") {
      removedContainers.push("moov/trak/uuid");
      changed = replaceWithFree(bytes, child) || changed;
      continue;
    }
    if (USER_METADATA_CONTAINERS.has(child.type)) {
      removedContainers.push(`moov/trak/${child.type}`);
      changed = replaceWithFree(bytes, child) || changed;
      continue;
    }
    if (child.type === "mdia") {
      for (const mdiaChild of parseBoxes(bytes, child.position + child.headerSize, child.position + child.size)) {
        if (mdiaChild.type === "mdhd") changed = clearTimestamps(bytes, mdiaChild) || changed;
        if (mdiaChild.type === "uuid") {
          removedContainers.push("moov/trak/mdia/uuid");
          changed = replaceWithFree(bytes, mdiaChild) || changed;
          continue;
        }
        if (USER_METADATA_CONTAINERS.has(mdiaChild.type)) {
          removedContainers.push(`moov/trak/mdia/${mdiaChild.type}`);
          changed = replaceWithFree(bytes, mdiaChild) || changed;
        }
      }
    }
  }

  return changed;
}

function scrubMoov(bytes) {
  let changed = false;
  const removedContainers = [];

  for (const child of parseBoxes(bytes, 8, bytes.length)) {
    if (child.type === "mvhd") changed = clearTimestamps(bytes, child) || changed;
    if (child.type === "uuid") {
      removedContainers.push("moov/uuid");
      changed = replaceWithFree(bytes, child) || changed;
      continue;
    }
    if (USER_METADATA_CONTAINERS.has(child.type)) {
      removedContainers.push(`moov/${child.type}`);
      changed = replaceWithFree(bytes, child) || changed;
      continue;
    }
    if (child.type === "trak") changed = scrubTrack(bytes, child, removedContainers) || changed;
  }

  return { changed, removedContainers };
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function containsMarker(value) {
  const text = lower(value);
  return MARKERS.some((marker) => text.includes(marker));
}

function parseJson(value) {
  if (!value || !(value.startsWith("{") || value.startsWith("["))) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function maskId(value) {
  if (!value || value.length < 12) return value || "";
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function describeEntry(entry) {
  const key = lower(entry.key);
  const value = entry.value || "";
  const json = parseJson(value);

  if (key === "com.apple.quicktime.artwork" && (containsMarker(value) || json)) {
    const data = json?.data ?? {};
    return {
      ...entry,
      type: "Editor fingerprint",
      reason: "Contains a complete editor export record, including the internal product name and a unique video ID.",
      displayValue: `source=${json?.source_type || data.product || "editor"}${data.appVersion ? ` · app ${data.appVersion}` : ""}${data.videoId ? ` · ID ${maskId(data.videoId)}` : ""}`,
      culprit: true,
      details: {
        "Internal source": json?.source_type || data.product || "Unknown",
        "App version": data.appVersion || "Unknown",
        "Platform": data.os || data.source_platform || "Unknown",
        "Editor scene": data.editorScene || "Unknown",
        "Export type": data.exportType || "Unknown",
        "Unique video ID": maskId(data.videoId)
      }
    };
  }

  if (key === "te_is_reencode") {
    return { ...entry, type: "ByteDance flag", reason: "Marks the file as re-encoded by the editor pipeline.", displayValue: value || "1" };
  }
  if (key === "dreaminametainfo") {
    return { ...entry, type: "Dreamina marker", reason: "ByteDance/Dreamina-specific metadata field.", displayValue: value || "Present" };
  }
  if (key === "hw") {
    return { ...entry, type: "Vendor flag", reason: "Non-standard export flag added by the editor.", displayValue: value || "Present" };
  }
  if (key === "encoder") {
    return { ...entry, type: "Encoder signature", reason: "Reveals the software library used to create the container.", displayValue: value };
  }
  if (key.includes("creation time") || key.includes("modification time") || key === "creation_time") {
    return { ...entry, type: "Timestamp", reason: "Unnecessary export or container timestamp.", displayValue: value };
  }
  if (["moov_pos", "mdat_pos", "bitrate", "maxrate", "minor_version", "major_brand", "compatible_brands"].includes(key)) {
    return { ...entry, type: "Redundant export data", reason: "Duplicate or derived field not needed for playback.", displayValue: value };
  }
  if (containsMarker(entry.key) || containsMarker(value)) {
    return { ...entry, type: "Editor identifier", reason: "Matches a known CapCut, Vicut, ByteDance, or Dreamina marker.", displayValue: value || "Present" };
  }

  return {
    ...entry,
    type: entry.kind === "timestamp" ? "Timestamp" : "User metadata",
    reason: "Not required for video or audio playback.",
    displayValue: value || "Present"
  };
}

function buildDetection(entries) {
  const described = entries.map(describeEntry);
  const culprit = described.find((entry) => entry.culprit) ?? null;
  const hasVicut = described.some((entry) => containsMarker(entry.key) || containsMarker(entry.value));
  const identifiers = described.filter((entry) =>
    ["Editor fingerprint", "ByteDance flag", "Dreamina marker", "Vendor flag", "Editor identifier"].includes(entry.type)
  );

  return {
    editor: hasVicut ? "CapCut / Vicut" : null,
    vendor: hasVicut ? "ByteDance editor metadata" : null,
    culprit,
    identifiers,
    described
  };
}

function parseFtyp(bytes) {
  if (bytes.length < 16 || fourCC(bytes, 4) !== "ftyp") return null;
  const majorBrand = fourCC(bytes, 8);
  const minorVersion = readU32(bytes, 12);
  const compatibleBrands = [];
  for (let offset = 16; offset + 4 <= bytes.length; offset += 4) compatibleBrands.push(fourCC(bytes, offset));
  return { majorBrand, minorVersion, compatibleBrands };
}

async function readTopLevelBoxes(file) {
  const boxes = [];
  let position = 0;

  while (position + 8 <= file.size) {
    const header = new Uint8Array(await file.slice(position, Math.min(position + 16, file.size)).arrayBuffer());
    if (header.length < 8) break;

    let size = readU32(header, 0);
    const type = fourCC(header, 4);
    let headerSize = 8;

    if (size === 1) {
      if (header.length < 16) break;
      size = readU64(header, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - position;
    }

    if (size < headerSize || position + size > file.size) {
      throw new Error("This does not appear to be a valid MOV or MP4 file.");
    }

    boxes.push({ position, size, type, headerSize });
    position += size;
  }

  return boxes;
}

function outputName(inputName) {
  const match = inputName.match(/^(.*?)(\.[^.]+)?$/);
  const base = match?.[1] || "video";
  const extension = (match?.[2] || ".mov").toLowerCase();
  return `${base}-clean${extension}`;
}

function buildPatchedBlob(file, patches) {
  const sorted = [...patches].sort((a, b) => a.position - b.position);
  const parts = [];
  let cursor = 0;

  for (const patch of sorted) {
    parts.push(file.slice(cursor, patch.position));
    parts.push(patch.bytes);
    cursor = patch.position + patch.bytes.length;
  }

  parts.push(file.slice(cursor));
  return new Blob(parts, { type: file.type || "video/quicktime" });
}

function mediaSignature(analysis) {
  return analysis.tracks.map((track) => ({
    type: track.type,
    codec: track.codec,
    dimensions: track.dimensions,
    bitDepth: track.bitDepth,
    chromaFormat: track.chromaFormat,
    dolbyVision: track.dolbyVision
  }));
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatContainer(extension, ftyp) {
  if (extension === "mov" || ftyp?.majorBrand === "qt  ") return "QuickTime MOV";
  return "MP4";
}

export async function inspectAndClean(file) {
  if (!file || file.size < 16) throw new Error("Choose a valid video file.");
  const extension = file.name?.split(".").pop()?.toLowerCase();
  if (extension !== "mov" && extension !== "mp4") throw new Error("Choose a MOV or MP4 file.");

  const topLevelBoxes = await readTopLevelBoxes(file);
  const patches = [];
  const allMetadata = [];
  let ftyp = null;
  let beforeMoov = null;
  let afterMoov = null;
  let topLevelChanged = false;

  for (const box of topLevelBoxes) {
    if (box.type === "ftyp") {
      const bytes = new Uint8Array(await file.slice(box.position, box.position + box.size).arrayBuffer());
      ftyp = parseFtyp(bytes);
      continue;
    }

    if (box.type === "moov") {
      const original = new Uint8Array(await file.slice(box.position, box.position + box.size).arrayBuffer());
      beforeMoov = analyzeMoov(original);
      allMetadata.push(...beforeMoov.metadata);

      const cleaned = original.slice();
      const scrubbed = scrubMoov(cleaned);
      afterMoov = analyzeMoov(cleaned);
      if (scrubbed.changed) patches.push({ position: box.position, bytes: cleaned });
      continue;
    }

    if (USER_METADATA_CONTAINERS.has(box.type) || box.type === "uuid") {
      const original = new Uint8Array(await file.slice(box.position, box.position + box.size).arrayBuffer());
      if (box.type === "meta") allMetadata.push(...parseMetaEntries(original, "root/meta"));
      if (box.type === "udta") allMetadata.push(...parseUdtaEntries(original, "root/udta"));
      if (box.type === "uuid") {
        allMetadata.push({ key: "UUID metadata", value: printableText(original.slice(box.headerSize)), path: "root/uuid", kind: "user-data" });
      }
      const cleaned = original.slice();
      if (replaceWithFree(cleaned, { position: 0, size: cleaned.length })) {
        patches.push({ position: box.position, bytes: cleaned });
        topLevelChanged = true;
      }
    }
  }

  if (!beforeMoov) throw new Error("The file does not contain a readable movie header.");
  if (!afterMoov) afterMoov = beforeMoov;

  const detection = buildDetection(allMetadata);
  const blob = patches.length > 0 ? buildPatchedBlob(file, patches) : new Blob([file], { type: file.type || "video/quicktime" });
  if (blob.size !== file.size) throw new Error("The output failed its size-preservation check.");

  const beforeSignature = mediaSignature(beforeMoov);
  const afterSignature = mediaSignature(afterMoov);
  const mediaUnchanged = sameJson(beforeSignature, afterSignature);
  if (!mediaUnchanged) throw new Error("The media-preservation check failed. No output was created.");

  const video = beforeMoov.tracks.find((track) => track.type === "vide") ?? null;
  const audio = beforeMoov.tracks.find((track) => track.type === "soun") ?? null;

  return {
    changed: patches.length > 0 || topLevelChanged,
    blob,
    name: outputName(file.name),
    report: {
      file: {
        inputName: file.name,
        outputName: outputName(file.name),
        size: file.size,
        container: formatContainer(extension, ftyp),
        duration: beforeMoov.duration
      },
      media: {
        video,
        audio,
        unchanged: mediaUnchanged,
        mdatUntouched: true,
        hdrRetained: Boolean(video?.dolbyVision)
      },
      detection,
      metadata: {
        input: detection.described,
        removed: detection.described,
        inputCount: detection.described.length,
        outputUserFieldCount: afterMoov.metadata.length
      },
      checks: {
        sameFileSize: blob.size === file.size,
        sameContainer: true,
        mediaUnchanged,
        technicalMetadataPreserved: mediaUnchanged
      }
    }
  };
}
