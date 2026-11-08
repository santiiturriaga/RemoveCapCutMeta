// Surgical ISO BMFF / QuickTime metadata cleanup.
// Remove indexed CapCut/ByteDance keys and ilst items as valid, smaller boxes.
// Pad ONLY at the outer moov (or top-level) boundary with a standard free box.
// The full moov/top-level byte extent and every media chunk offset stay unchanged.
// All unknown technical boxes, including stsd/colr/hvcC/dvcC/dvvC/uuid, remain intact.
const decoder=new TextDecoder("utf-8");
const markers=["capcut","bytedance","dreamina","vicut","te_is_reencode",
 "com.lemon.lvoverseas","lvoverseas"];
const u32=(b,p)=>new DataView(b.buffer,b.byteOffset+p,4).getUint32(0,false);
const w32=(b,p,v)=>new DataView(b.buffer,b.byteOffset+p,4).setUint32(0,v>>>0,false);
const typeAt=(b,p)=>String.fromCharCode(b[p],b[p+1],b[p+2],b[p+3]);
const text=b=>decoder.decode(b).replaceAll("\0","");
const hasMarker=x=>markers.some(y=>String(x||"").toLowerCase().includes(y));
function boxList(b,start,end) {
  const result=[];let pos=start;
  while(pos+8<=end) {
    let size=u32(b,pos); const type=typeAt(b,pos+4);let head=8;
    if(size===1) {
      if(pos+16>end) throw Error("Truncated MP4 box");
      const v=new DataView(b.buffer,b.byteOffset+pos+8,8).getBigUint64(0,false);
      if(v>BigInt(Number.MAX_SAFE_INTEGER)) throw Error("MP4 box too large");
      size=Number(v);head=16;
    } else if(size===0) size=end-pos;
    if(size<head || size>end-pos) throw Error("Invalid " + type + " box length");
    result.push({pos,size,type,head});
    pos+=size;
  }
  if(pos!==end) throw Error("Invalid trailing MP4 box bytes");
  return result;
}
function concat(parts) {
  const length=parts.reduce((n,b)=>n+b.length,0);
  const out=new Uint8Array(length);let pos=0;
  for(const b of parts) {out.set(b,pos);pos+=b.length;}
  return out;
}
function repack(original, headerEnd, contents) {
  const header=original.slice(0,headerEnd);
  const bytes=concat([header,...contents]);
  const head=u32(original,0)===1?16:8;
  if(head===16) {
    new DataView(bytes.buffer).setBigUint64(8,BigInt(bytes.length),false);
  } else {
    if(bytes.length>0xffffffff) throw Error("Very large MP4 box unsupported");
    w32(bytes,0,bytes.length);
  }
  return bytes;
}
function freeBox(bytes) {
  if(bytes<8 || bytes>0xffffffff) throw Error("Cannot safely pad this metadata gap");
  const result=new Uint8Array(bytes);
  w32(result,0,bytes);
  result.set([102,114,101,101],4);
  return result;
}
function metaChildrenStart(b) {
  const head=u32(b,0)===1?16:8;
  if(b.length<head+8) return head+4;
  const next=u32(b,head);
  if(next>=8 && next<=b.length-head && typeAt(b,head+4).split("").every(c=>c.charCodeAt(0)>=32)) return head;
  return head+4; // FullBox version/flags
}
function keyRecords(keys) {
  const off=u32(keys,0)===1?16:8;
  if(off+8>keys.length) throw Error("Invalid metadata keys");
  const count=u32(keys,off+4);
  if(count>100000) throw Error("Invalid metadata key count");
  let pos=off+8;
  const items=[];
  for(let i=0;i<count;i++) {
    if(pos+8>keys.length) throw Error("Truncated metadata key");
    const size=u32(keys,pos);
    if(size<8 || size>keys.length-pos) throw Error("Invalid metadata key");
    items.push({bytes:keys.slice(pos,pos+size),name:text(keys.subarray(pos+8,pos+size))});
    pos+=size;
  }
  if(pos!==keys.length) throw Error("Unexpected trailing metadata key bytes");
  return {items,off};
}
function getValue(bytes,entry) {
  const payload=bytes.subarray(entry.pos+entry.head,entry.pos+entry.size);
  let inside;
  try {inside=boxList(payload,0,payload.length);}catch{inside=[];}
  const data=inside.find(x=>x.type==="data");
  if(!data) return text(payload);
  const offset=Math.min(data.pos+data.head+8,data.pos+data.size);
  return text(payload.subarray(offset,data.pos+data.size));
}
function rewriteMeta(original, path, vendor, removed) {
  const head=u32(original,0)===1?16:8;
  const first=metaChildrenStart(original);
  const children=boxList(original,first,original.length);
  const keysBox=children.find(x=>x.type==="keys");
  const listBox=children.find(x=>x.type==="ilst");
  if(!listBox) return original;
  const keys=keysBox?keyRecords(original.slice(keysBox.pos,keysBox.pos+keysBox.size)):null;
  const ilst=original.slice(listBox.pos,listBox.pos+listBox.size);
  const entries=boxList(ilst,8,ilst.length);
  const droppedIndices=new Set();
  const droppedEntries=new Set();
  const knownKey=keys?.items || [];
  for(const entry of entries) {
    const index=u32(ilst,entry.pos+4);
    const name=keys&&index>=1&&index<=knownKey.length?knownKey[index-1].name:entry.type;
    const value=getValue(ilst,entry);
    if(hasMarker(name)||hasMarker(value)||(vendor&&name.toLowerCase()==="hw")) {
      droppedEntries.add(entry.pos);
      if(keys&&index>=1&&index<=knownKey.length) droppedIndices.add(index);
      removed.push({key:name,path:path+"/ilst"});
    }
  }
  if(keys) {
    for(let index=0;index<keys.items.length;index++) if(hasMarker(keys.items[index].name)) {
      droppedIndices.add(index+1);
      // A dangling key with no ilst item is still identifying metadata.
      if(!entries.some(e=>u32(ilst,e.pos+4)===index+1)) removed.push({key:keys.items[index].name,path:path+"/keys"});
    }
  }
  if(droppedEntries.size===0 && droppedIndices.size===0) return original;
  const remap=new Map();
  let newKeysBox=null;
  if(keys) {
    const kept=keys.items.filter((item,i)=> {
      if(droppedIndices.has(i+1)) return false;
      remap.set(i+1,remap.size+1);
      return true;
    });
    const old=original.slice(keysBox.pos,keysBox.pos+keysBox.size);
    const prefix=old.slice(0,keys.off+8);
    w32(prefix,keys.off+4,kept.length);
    newKeysBox=repack(old,keys.off+8,[...kept.map(x=>x.bytes)]);
    // repack copied the old count; put the corrected count in output.
    w32(newKeysBox,keys.off+4,kept.length);
  }
  const keptEntries=[];
  for(const item of entries) {
    const oldIndex=u32(ilst,item.pos+4);
    if(droppedEntries.has(item.pos) || droppedIndices.has(oldIndex)) continue;
    const bytes=ilst.slice(item.pos,item.pos+item.size);
    if(keys && remap.has(oldIndex)) w32(bytes,4,remap.get(oldIndex));
    keptEntries.push(bytes);
  }
  const newList=repack(ilst,8,keptEntries);
  const childBytes=children.map(child=>{
    if(child===listBox) return newList;
    if(child===keysBox && newKeysBox) return newKeysBox;
    return original.slice(child.pos,child.pos+child.size);
  });
  return repack(original,first,childBytes);
}
function rewriteContainer(original,type,path,vendor,removed) {
  if(type==="meta") return rewriteMeta(original,path,vendor,removed);
  const head=u32(original,0)===1?16:8;
  const children=boxList(original,head,original.length);
  let changed=false;
  const content=[];
  for(const child of children) {
    const input=original.slice(child.pos,child.pos+child.size);
    let result=input;
    if(["udta","meta","trak","mdia"].includes(child.type)) {
      result=rewriteContainer(input,child.type,path+"/"+child.type,vendor,removed);
    } else if(type==="udta" && !["uuid","free"].includes(child.type)) {
      const value=text(input.subarray(child.head,Math.min(input.length,1024*1024)));
      if(hasMarker(child.type)||hasMarker(value)||(vendor&&child.type.toLowerCase()==="hw")) {
        removed.push({key:child.type,path});
        result=null;
      }
    }
    if(result===null || result.length!==input.length) changed=true;
    if(result!==null) content.push(result);
  }
  return changed?repack(original,head,content):original;
}
function padContainer(original,rebuilt,type) {
  if(rebuilt.length===original.length) return rebuilt;
  const gap=original.length-rebuilt.length;
  if(gap<8) throw Error("Metadata entry too small for a safe free box");
  if(type==="moov") {
    const head=u32(original,0)===1?16:8;
    return repack(original,head,[rebuilt.subarray(head),freeBox(gap)]);
  }
  return concat([rebuilt,freeBox(gap)]);
}
export function removeEditorMetadataFromBox(input, type, { vendorDetected=false }={}) {
  const bytes=new Uint8Array(input);
  if(bytes.length<8 || typeAt(bytes,4)!==type) throw Error("Invalid " + type + " box input");
  const removed=[];
  let rebuilt;
  if(type==="moov" || type==="udta" || type==="meta") {
    rebuilt=rewriteContainer(bytes,type,type,vendorDetected,removed);
  } else throw Error("Unsupported metadata container type");
  const output=padContainer(bytes,rebuilt,type);
  if(output.length!==bytes.length) throw Error("Metadata size preservation failed");
  return { bytes:output, removed, changed:removed.length>0 };
}
