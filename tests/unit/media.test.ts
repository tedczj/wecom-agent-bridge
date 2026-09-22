import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync,readFileSync,existsSync,symlinkSync,mkdirSync,utimesSync } from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import sharp from 'sharp';
import { MediaStore } from '../../src/media.ts';
import { setup } from '../helpers.ts';
async function image(file:string,width=8,height=8) { const bytes=await sharp({create:{width,height,channels:3,background:{r:20,g:40,b:60}}}).png().toBuffer();writeFileSync(file,bytes);return bytes; }
test('M01/B01: copied image bytes, dimensions, format and digest match',async t=>{
 const h=setup(t),file=path.join(h.root,'a.png'),bytes=await image(file),media=new MediaStore(h.c);
 const [ref]=await media.prepare(randomUUID(),[{path:file,source:'message'}]);assert(ref);assert.equal(ref.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(ref.width,8);assert.equal(ref.height,8);assert.deepEqual(await media.read(ref),bytes);await media.validate([ref]);
});
test('M03: byte and aggregate budgets reject input and remove partial directories',async t=>{
 const h=setup(t),file=path.join(h.root,'a.png');const bytes=await image(file);h.c.media.maxImageBytes=bytes.length-1;const media=new MediaStore(h.c),id=randomUUID();
 await assert.rejects(media.prepare(id,[{path:file,source:'message'}]),/MEDIA_SIZE/);assert(!existsSync(path.join(media.root,id)));
 h.c.media.maxImageBytes=1024;h.c.media.maxTotalBytes=bytes.length;await assert.rejects(media.prepare(randomUUID(),[{path:file,source:'message'},{path:file,source:'message'}]),/TOTAL_BYTES/);
});
test('M05: renamed HTML/SVG/executable are not accepted as images',async t=>{
 const h=setup(t),media=new MediaStore(h.c),file=path.join(h.root,'bad.png');
 for(const text of ['<html>not an image</html>','<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"></svg>','MZfake']) {writeFileSync(file,text);await assert.rejects(media.prepare(randomUUID(),[{path:file,source:'message'}]));}
});
test('M06: per-image and aggregate pixel limits are enforced',async t=>{
 const h=setup(t),file=path.join(h.root,'a.png');await image(file,20,20);const media=new MediaStore(h.c);
 h.c.media.maxPixels=100;await assert.rejects(media.prepare(randomUUID(),[{path:file,source:'message'}]));
 h.c.media.maxPixels=500;h.c.media.maxTotalPixels=500;await assert.rejects(media.prepare(randomUUID(),[{path:file,source:'message'},{path:file,source:'message'}]),/TOTAL_PIXELS/);
});
test('M06: truncated payload must pass full decode, not merely metadata',async t=>{
 const h=setup(t),file=path.join(h.root,'a.png'),bytes=await image(file,30,30);writeFileSync(file,bytes.subarray(0,Math.floor(bytes.length/2)));
 await assert.rejects(new MediaStore(h.c).prepare(randomUUID(),[{path:file,source:'message'}]));
});
test('M07/M08: missing files, symlinks, escaped references and tampering fail',async t=>{
 const h=setup(t),file=path.join(h.root,'a.png');await image(file);const media=new MediaStore(h.c),link=path.join(h.root,'link.png');symlinkSync(file,link);
 await assert.rejects(media.prepare(randomUUID(),[{path:link,source:'message'}]));
 await assert.rejects(media.prepare(randomUUID(),[{path:path.join(h.root,'missing'),source:'message'}]));
 const [ref]=await media.prepare(randomUUID(),[{path:file,source:'message'}]);assert(ref);
 await assert.rejects(media.read({...ref,localPath:file}),/MEDIA_PATH/);writeFileSync(ref.localPath,'tampered');await assert.rejects(media.read(ref),/MEDIA_HASH/);
});
test('M09/R01: active media survives TTL; inactive stale/partial files are removed',async t=>{
 const h=setup(t),media=new MediaStore(h.c),active=randomUUID(),inactive=randomUUID(),partial=randomUUID();
 for(const id of [active,inactive,partial]) {const dir=path.join(media.root,id);mkdirSync(dir);writeFileSync(path.join(dir,id===partial?'a.part':'a.png'),'x');if(id!==partial)utimesSync(dir,0,0);}
 assert.equal(await media.gc(new Set([active])),2);assert(existsSync(path.join(media.root,active)));assert(!existsSync(path.join(media.root,inactive)));
});
test('media: cancellation and count limit are checked before file I/O',async t=>{
 const h=setup(t),media=new MediaStore(h.c),abort=new AbortController();abort.abort();
 await assert.rejects(media.prepare(randomUUID(),[{path:'/missing',source:'message'}],abort.signal),/ABORTED/);
 await assert.rejects(media.prepare(randomUUID(),Array(5).fill({path:'/missing',source:'message'})),/MEDIA_COUNT/);
});

test('M06: valid animated WebP is rejected before Agent input',async t=>{
 const h=setup(t),file=path.join(h.root,'animated.webp');writeFileSync(file,Buffer.from('UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAFAAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAABAAABAABQAAAAVlA4IC4AAAA0AQCdASoCAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA','base64'));
 await assert.rejects(new MediaStore(h.c).prepare(randomUUID(),[{path:file,source:'message'}]),/MEDIA_ANIMATED/);
});
