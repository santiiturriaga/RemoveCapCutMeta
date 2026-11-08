import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { inspectAndClean } from '../cleaner.js';

const e = new TextEncoder();
const s = (x) => e.encode(x);
const u16 = (x) => Uint8Array.of(x >>> 8 & 255, x & 255);
const u32 = (x) => Uint8Array.of(x >>> 24 & 255, x >>> 16 & 255, x >>> 8 & 255, x & 255);
function join(...parts) {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { b.set(p, at); at += p.length; }
  return b;
}
function box(type, ...parts) {
  const payload = join(...parts);
  return join(u32(8 + payload.length), s(type), payload);
}
function meta({ editor = true, dreamina = false } = {}) {
  const names = editor ? ['com.apple.quicktime.artwork', 'com.apple.quicktime.camera', 'te_is_reencode'] : ['com.apple.quicktime.artwork', 'com.apple.quicktime.camera'];
  if (dreamina) names.push('DreaminaMetaInfo');
  const records = names.map((name) => join(u32(name.length + 8), s('mdta'), s(name)));
  const keys = box('keys', u32(0), u32(names.length), ...records);
  const data = (value) => box('data', new Uint8Array(8), s(value));
  const item = (index, value) => {
    const bytes = data(value);
    return join(u32(bytes.length + 8), u32(index), bytes);
  };
  const ilst = box('ilst',
    item(1, editor ? '{"source_type":"CapCut","product":"Vicut"}' : 'Natural camera metadata'),
    item(2, 'iPhone HDR Camera'),
    ...(editor ? [item(3, '1')] : []),
    ...(dreamina ? [item(names.length, 'Dreamina 2026 export')] : []));
  return box('meta', u32(0), box('hdlr', u32(0), u32(0), s('mdta'), new Uint8Array(12)), keys, ilst);
}
function source({ transfer = 16, editor = true, dv = false, nested = false, hdr = true, uuid = true, dreamina = false } = {}) {
  const sample = box('hvc1', new Uint8Array(78),
    box('hvcC', Uint8Array.of(1, 2, 3, 4, 5, 6, 7)),
    ...(hdr ? [box('colr', s('nclx'), u16(9), u16(transfer), u16(9), Uint8Array.of(0))] : []),
    ...(dv ? [box('dvvC', Uint8Array.of(1, 0, 0x10, 0x2a, 0x30))] : []));
  const stsd = box('stsd', u32(0), u32(1), sample);
  const mdia = box('mdia',
    box('hdlr', u32(0), u32(0), s('vide'), new Uint8Array(12)),
    box('minf', box('stbl', stsd)),
    ...(nested ? [box('udta', meta({ editor, dreamina }))] : []));
  const film = box('trak', mdia);
  const moov = box('moov', film,
    ...(nested ? [] : [box('udta', meta({ editor, dreamina }))]),
    ...(uuid ? [box('uuid', s('VideoTechnicalUUID-1234'))] : []));
  const ftyp = box('ftyp', s('isom'), u32(0), s('isom'));
  const mdat = box('mdat', Uint8Array.of(0, 1, 5, 9, 255, 128, 11));
  return new File([ftyp, moov, mdat], 'sample.mp4', { type: 'video/mp4' });
}
const bytes = async (file) => new Uint8Array(await file.arrayBuffer());
const has = (b, text) => new TextDecoder().decode(b).includes(text);

test('PQ HDR clean keeps exact byte count, technical codec atoms, UUID and encoded media', async () => {
  const file = source();
  const before = await bytes(file);
  const result = await inspectAndClean(file);
  const after = await bytes(result.blob);
  assert.equal(result.changed, true);
  assert.equal(after.length, before.length);
  assert.equal(result.report.media.video.color.transfer, 16);
  assert.equal(result.report.media.hdrRetained, true);
  assert.equal(result.report.checks.mediaUnchanged, true);
  assert.ok(!has(after, 'CapCut') && !has(after, 'Vicut') && !has(after, 'te_is_reencode'));
  assert.ok(has(after, 'iPhone HDR Camera'), 'unrelated user metadata retained');
  assert.ok(has(after, 'VideoTechnicalUUID-1234'), 'UUID technical metadata retained');
  const mdatStart = before.findIndex((x, i) => x === 109 && before[i+1] === 100 && before[i+2] === 97 && before[i+3] === 116);
  assert.ok(mdatStart >= 0);
  assert.deepEqual(after.slice(mdatStart), before.slice(mdatStart), 'mdat and encoded bytes unchanged');
  const stsdStart = before.findIndex((x, i) => x === 115 && before[i+1] === 116 && before[i+2] === 115 && before[i+3] === 100) - 4;
  assert.ok(stsdStart >= 0);
  const stsdSize = new DataView(before.buffer).getUint32(stsdStart);
  assert.deepEqual(after.slice(stsdStart, stsdStart + stsdSize), before.slice(stsdStart, stsdStart + stsdSize));
  assert.equal(result.report.metadata.removed.length, 2);
  const again = await inspectAndClean(new File([after], 'again.mp4', { type: 'video/mp4' }));
  assert.equal(again.changed, false, 'idempotent cleanup');
});

test('Without a CapCut marker, even HDR+UUID footage is byte-identical', async () => {
  const file = source({ editor: false });
  const result = await inspectAndClean(file);
  assert.equal(result.changed, false);
  assert.deepEqual(await bytes(result.blob), await bytes(file));
  assert.equal(result.report.metadata.removed.length, 0);
});
test('SDR source stays SDR; metadata removal cannot manufacture HDR', async () => {
  const result = await inspectAndClean(source({ transfer: 1 }));
  assert.equal(result.report.media.video.color.transfer, 1);
  assert.equal(result.report.media.hdrRetained, false);
  assert.equal(result.report.checks.technicalMetadataPreserved, true);
});
test('HLG and Dolby Vision information survives cleanup', async () => {
  const hlg = await inspectAndClean(source({ transfer: 18 }));
  assert.equal(hlg.report.media.video.color.transfer, 18);
  assert.equal(hlg.report.media.hdrRetained, true);
  const dv = await inspectAndClean(source({ transfer: 1, dv: true }));
  assert.ok(dv.report.media.video.dolbyVision);
  assert.equal(dv.report.media.hdrRetained, true);
});
test('CapCut metadata nested directly in mdia is removed without touching sample descriptions', async () => {
  const file = source({ nested: true });
  const result = await inspectAndClean(file);
  assert.equal(result.changed, true);
  assert.ok(!has(await bytes(result.blob), 'CapCut'));
  assert.equal(result.report.checks.mediaUnchanged, true);
});
test('Unknown HDR without colr/dvvC is not wrongly labeled HDR', async () => {
  const result = await inspectAndClean(source({ hdr: false }));
  assert.equal(result.report.media.video.color, undefined);
  assert.equal(result.report.media.hdrRetained, null, 'no HDR indicator is not proof of SDR');
  assert.equal(result.report.checks.mediaUnchanged, true);
});


test('cleaned ilst is valid, compact, and correctly renumbers surviving indexed keys', async () => {
  const original = await bytes(source({ transfer: 18, editor: true, dv: true }));
  const result = await inspectAndClean(new File([original], 'preserve.mp4', { type: 'video/mp4' }));
  const cleaned = await bytes(result.blob);
  const findAscii = (array, needle) => {
    const pattern = new TextEncoder().encode(needle);
    for (let n = 0; n <= array.length - pattern.length; n += 1) {
      if (pattern.every((value, k) => array[n + k] === value)) return n;
    }
    return -1;
  };
  const u32 = (b, off) => new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0);
  const be32 = (b, off) => new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0,false);
  const oldPos=findAscii(original,'ilst')-4;
  const newPos=findAscii(cleaned,'ilst')-4;
  assert.ok(oldPos >= 0 && newPos >= 0);
  const oldSize=be32(original,oldPos), newSize=be32(cleaned,newPos);
  assert.ok(newSize < oldSize, 'real metadata removal shrinks ilst instead of replacing with junk');
  assert.equal(be32(original,oldPos+8+4),1);
  assert.equal(be32(cleaned,newPos+8+4),1, 'first and only surviving key is index 1');
  let offset=newPos+8, count=0;
  while(offset+8 <= newPos+newSize){
    const size=be32(cleaned,offset);
    assert.ok(size>=8 && offset+size<=newPos+newSize);
    assert.equal(be32(cleaned,offset+4),1, 'renumbered indexed keys remain valid');
    offset+=size;count++;
  }
  assert.equal(count,1);
  assert.equal(offset,newPos+newSize);
  assert.deepEqual(cleaned.subarray(0,32),original.subarray(0,32));
  assert.equal(result.report.file.outputSize,original.length,'outer movie padded with free, offsets unchanged');
  assert.ok(findAscii(cleaned,'iPhone HDR Camera')>0,'unrelated camera field retained');
  assert.equal(findAscii(cleaned,'te_is_reencode'),-1);
});


test('Dreamina metadata is really removed, not replaced by placeholder names', async () => {
  const input = source({ transfer: 18, editor: true, dv: true, dreamina: true });
  const result = await inspectAndClean(input);
  const output = await bytes(result.blob);
  const asText = new TextDecoder().decode(output);
  assert.ok(!asText.includes('DreaminaMetaInfo'));
  assert.ok(!asText.includes('te_is_reencode'));
  assert.ok(!asText.includes('CapCut'));
  assert.ok(asText.includes('iPhone HDR Camera'), 'unrelated HDR camera entry retained');
  assert.equal(result.report.media.hdrRetained, true);
  assert.equal(result.report.checks.mediaUnchanged, true);
  assert.equal(result.report.metadata.removed.length,3);
});
test('root-level editor meta box is rebuilt and padded without moving media offsets', async () => {
  const original=await bytes(source({ editor:false }));
  const size = new DataView(original.buffer, original.byteOffset, 4).getUint32(0,false);
  const annotated=new File([original.slice(0,size),meta({editor:true}),original.slice(size)],
    'root.mp4',{type:'video/mp4'});
  const cleaned=await inspectAndClean(annotated);
  const result=await bytes(cleaned.blob);
  const asText=new TextDecoder().decode(result);
  assert.equal(result.length,annotated.size);
  assert.ok(!asText.includes('CapCut'));
  assert.ok(!asText.includes('te_is_reencode'));
  assert.ok(asText.includes('iPhone HDR Camera'));
  assert.equal(cleaned.report.checks.mediaUnchanged,true);
});
