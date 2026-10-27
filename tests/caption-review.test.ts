import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { importWebVtt } from '@accountability/processing/captions';
import { projectCaptionReview,renderCaptionReview } from '../src/caption-review.ts';
import { hashBytes } from '../src/contracts.ts';
import type { Context } from '../src/contracts.ts';
const c:Context={tenantId:'t',projectId:'p',actor:{id:'owner',kind:'human',roles:['owner']},purpose:'research',requestId:'r',now:'2026-01-01T00:00:00Z'};
function fixture(count=2){
 const bytes=Buffer.from('\uFEFFWEBVTT\r\n\r\n'+Array.from({length:count},(_,i)=>`cue-${i}\r\n00:00.000 --> 00:01.000\r\n${i===0?'Fictional café </script><script>window.injected=true</script>':'Another cue '+i}\r\n`).join('\r\n'));
 const captions={source:{tenantId:'t',projectId:'p',kind:'evidence',id:'captions',revision:2},bytes,sha256:hashBytes(bytes),scanStatus:'clean' as const,processingAllowed:true};
 const media={source:{...captions.source,id:'media',revision:7},sha256:'a'.repeat(64),durationMs:2000,processingAllowed:true};
 const derivative=importWebVtt(c,captions,media);
 return {captions,media,derivative:{ref:{...captions.source,kind:'processed-artifact',id:'transcript',revision:9},sha256:derivative.sha256}};
}
test('review reparses exact bytes and preserves source/media/stored revisions with explicit uncertainty',()=>{
 const input=fixture(),snapshot=projectCaptionReview(c,input,'tested');
 assert.equal(snapshot.visibility,'private');assert.deepEqual(snapshot.events,[]);assert.deepEqual(snapshot.agents,[]);
 assert.deepEqual(snapshot.nodes.filter(n=>n.kind==='source').map(n=>n.ref.revision),[2,7]);
 assert(snapshot.nodes.filter(n=>n.ref.kind==='caption-cue-view').every(n=>n.ref.revision===9));
 assert(snapshot.nodes.some(n=>n.state==='unverified-supplied-transcript'));
 const cue=snapshot.nodes.find(n=>n.ref.kind==='caption-cue-view')!.details as {cue:{sourceByteStart:number;sourceByteEnd:number;text:string}};
 assert(input.captions.bytes.subarray(cue.cue.sourceByteStart,cue.cue.sourceByteEnd).toString().includes(cue.cue.text));
 input.captions.bytes.fill(0);assert.match(JSON.stringify(snapshot),/Fictional café/);
});
test('bounded windows expose global count and exact continuation without losing source dependencies',()=>{
 const snapshot=projectCaptionReview(c,fixture(4),'implemented',{offset:2,limit:1});
 const root=snapshot.nodes.find(n=>n.kind==='artifact')!,data=root.details as {window:{total:number;nextOffset:number}};
 assert.equal(data.window.total,4);assert.equal(data.window.nextOffset,3);assert.equal(snapshot.nodes.filter(n=>n.kind==='claim').length,1);
 assert(snapshot.nodes.some(n=>n.label.startsWith('Cue 3:')));
 for(const window of [{offset:-1},{offset:5},{limit:0},{limit:201}])assert.throws(()=>projectCaptionReview(c,fixture(4),'tested',window),{code:'invalid_window'});
});
test('scope, original bytes, stored digest and reference collisions are rejected before display',()=>{
 const foreign=fixture();foreign.media.source.projectId='other';assert.throws(()=>projectCaptionReview(c,foreign,'tested'));
 const wrong=fixture();wrong.derivative.sha256='0'.repeat(64);assert.throws(()=>projectCaptionReview(c,wrong,'tested'),{code:'derivative_mismatch'});
 const changed=fixture();changed.captions.bytes.fill(0);assert.throws(()=>projectCaptionReview(c,changed,'tested'));
 const stored=fixture();stored.derivative.ref.tenantId='other';assert.throws(()=>projectCaptionReview(c,stored,'tested'));
 const collision=fixture();collision.derivative.ref={...collision.captions.source};assert.throws(()=>projectCaptionReview(c,collision,'tested'),{code:'reference_collision'});
});
test('readable transcript and graph/table inspector share exact records while markup remains inert',()=>{
 const dom=new JSDOM(renderCaptionReview(c,fixture(),'tested'),{runScripts:'dangerously'});
 const document=dom.window.document,dialog=document.querySelector('dialog')!;
 dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');
 const section=[...document.querySelectorAll('section')].find(s=>s.querySelector('h2')?.textContent?.startsWith('Supplied transcript'))!;
 const button=section.querySelector<HTMLButtonElement>('button[data-node]')!;button.click();
 assert.match(document.querySelector('#detail-title')!.textContent!,/Cue 1/);
 assert.match(document.querySelector('#detail')!.textContent!,/sourceByteStart/);assert.match(section.textContent!,/Fictional café/);
 assert.equal((dom.window as unknown as {injected?:boolean}).injected,undefined);
 assert.equal(document.querySelectorAll('audio,video,iframe,script[src]').length,0);dom.window.close();
});
