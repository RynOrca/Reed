import test from 'node:test';
import assert from 'node:assert/strict';
import { singleSlotChecks } from './single-slot-report.mjs';
const fixture = () => ({
  root: 'C:\\synthetic', queuedCancellation: {observed:true,sentMainRequest:false}, overviewReady:true, upstreamPeak:1,
  requests:Array.from({length:4},()=>({status:200,streamComplete:true})),
  cases:['single-slot-notes','single-slot-follow-up'].map(name=>({name,outcome:{status:'complete'},text:`先画定向杆，用紫色，口令青铜海燕。见 \`summon-file:${encodeURIComponent('C:\\synthetic\\vault\\特征分解.md')}#L3\``})),
});
test('encoded original-note citation with a line reference passes',()=>assert.ok(Object.values(singleSlotChecks(fixture())).every(Boolean)));
test('similar text, wrong file/root, missing line or incomplete samples cannot prove note evidence',()=>{
  for(const change of [
    report=>report.cases[0].text='定向杆 紫色 青铜海燕 特征分解.md',
    report=>report.cases[0].text=report.cases[0].text.replace('#L3',''),
    report=>report.root='C:\\other',
    report=>report.cases.pop(),
    report=>report.cases[0].outcome.status='aborted',
  ]){const report=fixture();change(report);assert.equal(singleSlotChecks(report).notesEvidence,false);}
});
test('transport failure, parallel requests or a sent cancelled request remain failures',()=>{
  const report=fixture();report.requests[0].status=502;report.upstreamPeak=2;report.queuedCancellation.sentMainRequest=true;
  const checks=singleSlotChecks(report);assert.equal(checks.completedUpstream,false);assert.equal(checks.upstreamPeakOne,false);assert.equal(checks.cancelledMainNotSent,false);
});
