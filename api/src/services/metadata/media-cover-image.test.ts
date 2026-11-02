import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {decodeArtworkImage,decodeImage} from './media-cover-image.js';
import {resolveFfmpegBinary} from '../mediafiles/audioUtils.js';

test('large valid JPEG uses bounded native RGBA without raising the JS decoder budget',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'discogenius-large-jpeg-'));
  try {
    const file=path.join(directory,'large.jpg');
    execFileSync(resolveFfmpegBinary(),['-v','error','-f','lavfi','-i','color=c=orange:s=6000x4000','-frames:v','1','-threads','1','-pix_fmt','yuvj444p',file],{windowsHide:true,timeout:30_000});
    const bytes=fs.readFileSync(file);
    assert.throws(()=>decodeImage(bytes,'.jpg'),/maxMemoryUsageInMB limit exceeded/);
    const decoded=await decodeArtworkImage(bytes,'.jpg');
    assert.equal(decoded?.width,6000);assert.equal(decoded?.height,4000);
    assert.equal(decoded?.data.length,6000*4000*4);
    assert.equal(decoded?.data[3],255);
    assert.ok(decoded!.data[0]>decoded!.data[2],'decoded orange pixels survive');
    assert.deepEqual(fs.readFileSync(file),bytes,'native decoding does not change the original');
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});

test('JPEG native fallback does not bypass corrupt input or byte limits',async()=>{
  await assert.rejects(decodeArtworkImage(Buffer.from('not a jpeg'),'.jpg'));
  await assert.rejects(decodeArtworkImage(Buffer.alloc(33*1024*1024),'.jpg'),/32 MiB/);
});
