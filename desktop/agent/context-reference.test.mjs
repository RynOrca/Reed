import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceIdentity} from '../web/context-reference.js';

test('参考来源标题隐藏长路径，完整位置保留在详情；有真实标题时优先使用',()=>{
  const path='Agent\\学习笔记\\教材\\chapter3.md';
  assert.deepEqual(referenceIdentity({kind:'note',label:path}),{title:'chapter3',parent:'学习笔记 / 教材',location:'Agent/学习笔记/教材/chapter3.md'});
  assert.equal(referenceIdentity({kind:'note',label:'大语言模型基础',location:path}).title,'大语言模型基础');
  const goal=referenceIdentity({kind:'goal',label:'当前项目学习目标',pinned:true});assert.match(goal.parent,/每轮读取/);
});
