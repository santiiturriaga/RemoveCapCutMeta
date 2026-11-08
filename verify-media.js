// Browser-side, bounded-memory verification of video payload and sample descriptions.
// This compares the file supplied to the page with its output or a re-imported
// saved copy. It never invokes a codec and never changes the files.
function u32(b, at) {
  if (at + 4 > b.length) throw new Error("Truncated MP4 box");
  return new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, false);
}
function u64(b, at) {
  const v = new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, false);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 box exceeds safe file size");
  return Number(v);
}
function typeAt(b, at) {
  return String.fromCharCode(b[at],b[at + 1],b[at + 2],b[at + 3]);
}
function parseBoxes(b, start, end) {
  const result = [];
  let at = start;
  while (at + 8 <= end) {
    let size = u32(b, at);
    const type = typeAt(b, at + 4);
    let head = 8;
    if (size === 1) {
      if (at + 16 > end) throw new Error("Truncated extended box");
      size = u64(b, at + 8); head = 16;
    } else if (!size) size = end - at;
    if (size < head || size > end - at) throw new Error("Invalid " + type + " size");
    result.push({ type, at, head, size });
    at += size;
  }
  if (at !== end) throw new Error("Unexpected trailing bytes in MP4 box list");
  return result;
}
async function topLevel(blob) {
  const boxes = [];
  let at = 0;
  while (at + 8 <= blob.size) {
    const b = new Uint8Array(await blob.slice(at, at + 16).arrayBuffer());
    let size = u32(b, 0), head = 8;
    const type = typeAt(b, 4);
    if (size === 1) {
      if (b.length < 16) throw new Error("Truncated large MP4 box");
      size = u64(b, 8); head = 16;
    } else if (!size) size = blob.size - at;
    if (size < head || size > blob.size - at) throw new Error("Bad MP4 " + type + " box");
    boxes.push({ type, at, head, size });
    at += size;
  }
  if (at !== blob.size) throw new Error("File has trailing unparsed bytes");
  return boxes;
}
function findChild(b, parent, type) {
  return parseBoxes(b, parent.at + parent.head, parent.at + parent.size)
    .find(x => x.type === type) ?? null;
}
function allStsd(b) {
  const root = { at:0, head:8, size:b.length };
  const result = [];
  for (const trak of parseBoxes(b, root.head, root.size).filter(x => x.type === "trak")) {
    const mdia = findChild(b, trak, "mdia");
    if (!mdia) continue;
    const minf = findChild(b, mdia, "minf");
    const stbl = minf && findChild(b, minf, "stbl");
    const stsd = stbl && findChild(b, stbl, "stsd");
    if (stsd) result.push(b.slice(stsd.at, stsd.at + stsd.size));
  }
  return result;
}
async function sampleDescriptions(blob, boxes) {
  const moov = boxes.find(x => x.type === "moov");
  if (!moov) throw new Error("No MP4 movie header");
  const bytes = new Uint8Array(await blob.slice(moov.at,moov.at + moov.size).arrayBuffer());
  return allStsd(bytes);
}
function equalBytes(a,b) {
  if (a.length !== b.length) return false;
  for (let i=0; i<a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
async function compareMdat(left, right, leftBoxes, rightBoxes, chunkSize) {
  const leftChunks = leftBoxes.filter(x => x.type === "mdat").map(x => ({
    start:x.at + x.head, length:x.size - x.head
  }));
  const rightChunks = rightBoxes.filter(x => x.type === "mdat").map(x => ({
    start:x.at + x.head, length:x.size - x.head
  }));
  if (!leftChunks.length || !rightChunks.length) return {
    equal:null, bytes:0, reason:"Encoded media data (mdat) not found"
  };
  const lsum=leftChunks.reduce((n,x)=>n+x.length,0);
  const rsum=rightChunks.reduce((n,x)=>n+x.length,0);
  if (lsum !== rsum) return { equal:false, bytes:lsum, savedBytes:rsum,
    reason:"Encoded media payload length changed" };
  let li=0, ri=0, lo=0, ro=0, total=0;
  while (total < lsum) {
    if (lo >= leftChunks[li].length) { li++; lo=0; continue; }
    if (ro >= rightChunks[ri].length) { ri++; ro=0; continue; }
    const n=Math.min(chunkSize, leftChunks[li].length-lo, rightChunks[ri].length-ro);
    const la=leftChunks[li].start+lo, ra=rightChunks[ri].start+ro;
    const ab=new Uint8Array(await left.slice(la,la+n).arrayBuffer());
    const bb=new Uint8Array(await right.slice(ra,ra+n).arrayBuffer());
    if (!equalBytes(ab,bb)) return { equal:false, bytes:lsum, savedBytes:rsum,
      reason:"Encoded video/audio bytes differ starting near payload offset " + total };
    total+=n; lo+=n; ro+=n;
  }
  return { equal:true, bytes:lsum, savedBytes:rsum, reason:"All encoded video/audio bytes match" };
}
export async function compareMediaFiles(original, candidate, { chunkSize=1024*1024 }={}) {
  if (!original || !candidate) throw new Error("Two media files are required");
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("Invalid chunk size");
  const [leftBoxes,rightBoxes]=await Promise.all([topLevel(original),topLevel(candidate)]);
  const [leftStsd,rightStsd]=await Promise.all([
    sampleDescriptions(original,leftBoxes),sampleDescriptions(candidate,rightBoxes)
  ]);
  const descriptionsIdentical=leftStsd.length > 0 && leftStsd.length === rightStsd.length
    && leftStsd.every((box,i)=>equalBytes(box,rightStsd[i]));
  const media=await compareMdat(original,candidate,leftBoxes,rightBoxes,chunkSize);
  return {
    originalBytes:original.size,
    candidateBytes:candidate.size,
    sampleDescriptionCount:leftStsd.length,
    sampleDescriptionsIdentical:descriptionsIdentical,
    encodedMediaBytesIdentical:media.equal,
    encodedMediaBytes:media.bytes,
    encodedMediaSavedBytes:media.savedBytes,
    reason:media.reason
  };
}
