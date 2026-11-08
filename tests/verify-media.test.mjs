import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { compareMediaFiles } from '../verify-media.js';

const enc=new TextEncoder();
const u32=x=>Uint8Array.of((x>>>24)&255,(x>>>16)&255,(x>>>8)&255,x&255);
function join(...list) {
  const out=new Uint8Array(list.reduce((n,x)=>n+x.length,0)); let n=0;
  for (const x of list) {out.set(x,n); n+=x.length;}
  return out;
}
const box=(type,...payload)=>{const data=join(...payload);return join(u32(data.length+8),enc.encode(type),data);};
function fixture({ frames=[1,2,3,4,5], tag=9, extra='', split=false, reordered=false }={}) {
  const stsd=box('stsd',u32(0),u32(1),box('hvc1',new Uint8Array(78),
    box('hvcC',Uint8Array.of(1,2,tag,4,5,6)),
    box('colr',enc.encode('nclx'),Uint8Array.of(0,9,0,18,0,9,0))));
  const moov=box('moov',box('trak',box('mdia',box('minf',box('stbl',stsd)))),
    ...(extra?[box('udta',box('name',enc.encode(extra)))]:[]));
  const payload=Uint8Array.from(frames);
  const mdats=split?[box('mdat',payload.subarray(0,2)),box('mdat',payload.subarray(2))]
    :[box('mdat',payload)];
  return new File([box('ftyp',enc.encode('isom'),u32(0),enc.encode('isom')),
    ...(reordered? [...mdats,moov]:[moov,...mdats])],
    'synthetic.mp4',{type:'video/mp4'});
}
test('metadata-only differences do not change either video bytes or codec setup',async()=>{
 const a=fixture({extra:'CapCut'});
 const b=fixture({extra:'unrelated metadata'});
 const result=await compareMediaFiles(a,b,{chunkSize:2});
 assert.equal(result.encodedMediaBytesIdentical,true);
 assert.equal(result.sampleDescriptionsIdentical,true);
 assert.notEqual(result.originalBytes,result.candidateBytes);
});
test('different video byte is detected even if length and codec config are identical',async()=>{
 const a=fixture(),b=fixture({frames:[1,2,3,99,5]});
 const result=await compareMediaFiles(a,b,{chunkSize:2});
 assert.equal(result.encodedMediaBytesIdentical,false);
 assert.equal(result.sampleDescriptionsIdentical,true);
});
test('changed Dolby/HEVC config is detected without changing any encoded samples',async()=>{
 const a=fixture(),b=fixture({tag:10});
 const result=await compareMediaFiles(a,b,{chunkSize:1});
 assert.equal(result.encodedMediaBytesIdentical,true);
 assert.equal(result.sampleDescriptionsIdentical,false);
});
test('remux-like reorder and mdat splitting is not mistaken for video conversion',async()=>{
 const a=fixture(),b=fixture({split:true,reordered:true});
 const result=await compareMediaFiles(a,b,{chunkSize:1});
 assert.equal(result.encodedMediaBytesIdentical,true);
 assert.equal(result.sampleDescriptionsIdentical,true);
});
test('empty invalid file is rejected rather than declared preserved',async()=>{
 await assert.rejects(compareMediaFiles(new Blob([Uint8Array.of(1)]),fixture()));
});
