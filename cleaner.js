const MARKERS = [
  "capcut",
  "bytedance",
  "dreamina",
  "vicut",
  "te_is_reencode",
  "com.lemon.lvoverseas",
  "lvoverseas"
];

const DIRECT_KEYS = new Set([
  "hw",
  "te_is_reencode",
  "dreaminametainfo"
]);

const RECURSIVE_CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "udta",
  "edts"
]);

const textDecoder = new TextDecoder("utf-8", { fatal: false });

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

function typeBytesToString(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function writeType(bytes, offset, type) {
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + index] = type.charCodeAt(index);
  }
}

function parseBoxes(bytes, start, end) {
  const boxes = [];
  let position = start;

  while (position + 8 <= end) {
    let size = readU32(bytes, position);
    const type = typeBytesToString(bytes, position + 4);
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

function makeBox(type, payload) {
  const result = new Uint8Array(8 + payload.length);
  writeU32(result, 0, result.length);
  writeType(result, 4, type);
  result.set(payload, 8);
  return result;
}

function join(parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function lowerAscii(bytes) {
  let result = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const value = bytes[index];
    result += String.fromCharCode(value >= 65 && value <= 90 ? value + 32 : value);
  }
  return result;
}

function containsMarker(bytes) {
  const text = lowerAscii(bytes);
  return MARKERS.some((marker) => text.includes(marker));
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

function scrubMeta(metaBytes) {
  if (metaBytes.length < 16 || typeBytesToString(metaBytes, 4) !== "meta") {
    return { bytes: metaBytes, removed: [] };
  }

  const childStart = metaChildrenStart(metaBytes);
  const children = parseBoxes(metaBytes, childStart, metaBytes.length);
  const keysBox = children.find((box) => box.type === "keys");
  const ilstBox = children.find((box) => box.type === "ilst");

  if (!keysBox || !ilstBox || keysBox.headerSize !== 8 || ilstBox.headerSize !== 8) {
    return { bytes: metaBytes, removed: [] };
  }

  const keysPayloadStart = keysBox.position + keysBox.headerSize;
  const keysPayloadEnd = keysBox.position + keysBox.size;
  if (keysPayloadEnd - keysPayloadStart < 8) {
    return { bytes: metaBytes, removed: [] };
  }

  const keyCount = readU32(metaBytes, keysPayloadStart + 4);
  const keyEntries = [];
  let keyPosition = keysPayloadStart + 8;

  for (let index = 0; index < keyCount; index += 1) {
    if (keyPosition + 8 > keysPayloadEnd) return { bytes: metaBytes, removed: [] };
    const keySize = readU32(metaBytes, keyPosition);
    if (keySize < 8 || keyPosition + keySize > keysPayloadEnd) {
      return { bytes: metaBytes, removed: [] };
    }

    const raw = metaBytes.slice(keyPosition, keyPosition + keySize);
    const name = textDecoder.decode(raw.slice(8));
    keyEntries.push({ raw, name });
    keyPosition += keySize;
  }

  const ilstEntries = parseBoxes(
    metaBytes,
    ilstBox.position + ilstBox.headerSize,
    ilstBox.position + ilstBox.size
  );

  const payloadByIndex = new Map();
  for (const entry of ilstEntries) {
    const index = readU32(metaBytes, entry.position + 4);
    const payload = metaBytes.slice(entry.position + entry.headerSize, entry.position + entry.size);
    const prior = payloadByIndex.get(index);
    payloadByIndex.set(index, prior ? join([prior, payload]) : payload);
  }

  const remove = new Set();
  const removed = [];

  keyEntries.forEach((entry, arrayIndex) => {
    const index = arrayIndex + 1;
    const key = entry.name.toLowerCase();
    const payload = payloadByIndex.get(index) ?? new Uint8Array();
    const directMatch = DIRECT_KEYS.has(key) || MARKERS.some((marker) => key.includes(marker));
    const payloadMatch = containsMarker(payload);

    if (directMatch || payloadMatch) {
      remove.add(index);
      removed.push(entry.name);
    }
  });

  if (remove.size === 0) {
    return { bytes: metaBytes, removed: [] };
  }

  const keptIndices = keyEntries
    .map((_, index) => index + 1)
    .filter((index) => !remove.has(index));
  const remap = new Map(keptIndices.map((oldIndex, newIndex) => [oldIndex, newIndex + 1]));

  const newKeysPayload = join([
    metaBytes.slice(keysPayloadStart, keysPayloadStart + 4),
    uint32Bytes(keptIndices.length),
    ...keptIndices.map((index) => keyEntries[index - 1].raw)
  ]);
  const newKeysBox = makeBox("keys", newKeysPayload);

  const newIlstEntries = [];
  for (const entry of ilstEntries) {
    const oldIndex = readU32(metaBytes, entry.position + 4);
    const newIndex = remap.get(oldIndex);
    if (!newIndex) continue;

    const copy = metaBytes.slice(entry.position, entry.position + entry.size);
    writeU32(copy, 4, newIndex);
    newIlstEntries.push(copy);
  }
  const newIlstBox = makeBox("ilst", join(newIlstEntries));

  const rebuiltChildren = children.map((child) => {
    if (child.type === "keys") return newKeysBox;
    if (child.type === "ilst") return newIlstBox;
    return metaBytes.slice(child.position, child.position + child.size);
  });

  const fixedPrefix = metaBytes.slice(8, childStart);
  const bodyWithoutPadding = join([fixedPrefix, ...rebuiltChildren]);
  const availableBodySize = metaBytes.length - 8;
  const paddingSize = availableBodySize - bodyWithoutPadding.length;

  if (paddingSize !== 0 && paddingSize < 8) {
    throw new Error("The metadata layout could not be safely rewritten.");
  }

  const parts = [bodyWithoutPadding];
  if (paddingSize >= 8) {
    const freeBox = new Uint8Array(paddingSize);
    writeU32(freeBox, 0, paddingSize);
    writeType(freeBox, 4, "free");
    parts.push(freeBox);
  }

  const rebuilt = new Uint8Array(metaBytes.length);
  writeU32(rebuilt, 0, rebuilt.length);
  writeType(rebuilt, 4, "meta");
  rebuilt.set(join(parts), 8);

  return { bytes: rebuilt, removed };
}

function uint32Bytes(value) {
  const bytes = new Uint8Array(4);
  writeU32(bytes, 0, value);
  return bytes;
}

function replaceWithFree(bytes, position, size) {
  if (size < 8 || size > 0xffffffff) return false;
  bytes.fill(0, position, position + size);
  writeU32(bytes, position, size);
  writeType(bytes, position + 4, "free");
  return true;
}

function scrubContainer(bytes, start, end, containerType, removed) {
  let changed = false;
  const children = parseBoxes(bytes, start, end);

  for (const child of children) {
    if (child.type === "meta") {
      const original = bytes.slice(child.position, child.position + child.size);
      const result = scrubMeta(original);
      if (result.removed.length > 0) {
        bytes.set(result.bytes, child.position);
        removed.push(...result.removed);
        changed = true;
      }
      continue;
    }

    if (child.type === "uuid" && child.size <= 2 * 1024 * 1024) {
      const payload = bytes.slice(child.position + child.headerSize, child.position + child.size);
      if (containsMarker(payload) && replaceWithFree(bytes, child.position, child.size)) {
        removed.push("vendor uuid metadata");
        changed = true;
      }
      continue;
    }

    if (containerType === "udta" && !RECURSIVE_CONTAINERS.has(child.type) && child.size <= 2 * 1024 * 1024) {
      const payload = bytes.slice(child.position + child.headerSize, child.position + child.size);
      if (containsMarker(payload) && replaceWithFree(bytes, child.position, child.size)) {
        removed.push(`user data ${child.type}`);
        changed = true;
      }
      continue;
    }

    if (RECURSIVE_CONTAINERS.has(child.type)) {
      const childChanged = scrubContainer(
        bytes,
        child.position + child.headerSize,
        child.position + child.size,
        child.type,
        removed
      );
      changed ||= childChanged;
    }
  }

  return changed;
}

async function readTopLevelBoxes(file) {
  const boxes = [];
  let position = 0;

  while (position + 8 <= file.size) {
    const header = new Uint8Array(await file.slice(position, Math.min(position + 16, file.size)).arrayBuffer());
    if (header.length < 8) break;

    let size = readU32(header, 0);
    const type = typeBytesToString(header, 4);
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

export async function cleanVideo(file) {
  if (!file || file.size < 16) throw new Error("Choose a valid video file.");

  const extension = file.name?.split(".").pop()?.toLowerCase();
  if (extension !== "mov" && extension !== "mp4") {
    throw new Error("Choose a MOV or MP4 file.");
  }

  const topLevelBoxes = await readTopLevelBoxes(file);
  const patches = [];
  const removed = [];

  for (const box of topLevelBoxes) {
    if (box.type === "moov") {
      const bytes = new Uint8Array(await file.slice(box.position, box.position + box.size).arrayBuffer());
      const changed = scrubContainer(bytes, box.headerSize, bytes.length, "moov", removed);
      if (changed) patches.push({ position: box.position, bytes });
      continue;
    }

    if (box.type === "meta" && box.size <= 64 * 1024 * 1024) {
      const original = new Uint8Array(await file.slice(box.position, box.position + box.size).arrayBuffer());
      const result = scrubMeta(original);
      if (result.removed.length > 0) {
        removed.push(...result.removed);
        patches.push({ position: box.position, bytes: result.bytes });
      }
    }
  }

  if (patches.length === 0) {
    return { changed: false, removed: [], blob: null, name: outputName(file.name) };
  }

  const blob = buildPatchedBlob(file, patches);
  if (blob.size !== file.size) {
    throw new Error("The output failed its size-preservation check.");
  }

  return {
    changed: true,
    removed: [...new Set(removed)],
    blob,
    name: outputName(file.name)
  };
}
