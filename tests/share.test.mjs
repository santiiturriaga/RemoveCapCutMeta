import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { shareWithFallback } from '../share.js';

const bytes = new Uint8Array([0, 1, 2, 77, 79, 79, 86, 255, 12]);

test('native share-sheet path passes exact generated MOV bytes, avoiding browser download', async () => {
  const blob = new Blob([bytes], { type: 'video/quicktime' });
  let downloaded = false, captured = null;
  const nav = {
    canShare: ({ files }) => files.length === 1 && files[0].name === 'test-clean.mov',
    share: async ({ files, title }) => {
      captured = { file: files[0], title };
    }
  };
  const behavior = await shareWithFallback({ blob, name: 'test-clean.mov' }, nav,
    () => { downloaded = true; }, File);
  assert.equal(behavior, 'shared');
  assert.equal(downloaded, false);
  assert.equal(captured.title, 'test-clean.mov');
  assert.equal(captured.file.type, 'video/quicktime');
  assert.deepEqual(new Uint8Array(await captured.file.arrayBuffer()), bytes);
});
test('no support for file sharing triggers browser fallback, not an empty action', async () => {
  let downloads = 0;
  const behavior = await shareWithFallback({ blob: new Blob([bytes], {type:'video/mp4'}), name:'test-clean.mp4' },
    { canShare: () => false, share: () => { throw Error('should not share'); } },
    () => { downloads++; }, File);
  assert.equal(behavior,'download');
  assert.equal(downloads,1);
});
test('user cancels share sheet without also triggering a download', async () => {
  let downloads=0;
  const nav={ canShare:()=>true, share:async()=>{ const e=new Error('cancelled');e.name='AbortError'; throw e; } };
  const result=await shareWithFallback({blob:new Blob([bytes]),name:'test-clean.mov'},nav,
    ()=>downloads++, File);
  assert.equal(result,'cancelled');
  assert.equal(downloads,0);
});
test('unexpected share error falls back to exact blob download', async () => {
  let downloads=0;
  const result=await shareWithFallback({blob:new Blob([bytes]),name:'test-clean.mp4'},
    { canShare:()=>true,share:async()=>{throw Error('OS share failed');} },
    ()=>downloads++, File);
  assert.equal(result,'download');
  assert.equal(downloads,1);
});
test('no output is inert', async () => {
  let downloads=0;
  assert.equal(await shareWithFallback(null,{},()=>downloads++,File),'no-output');
  assert.equal(downloads,0);
});
