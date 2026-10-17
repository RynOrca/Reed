import test from 'node:test';
import assert from 'node:assert/strict';
import {requestStatus} from '../web/request-status.js';

test('continuation reason never hides connecting, headers or silent wait',()=>{
  const reason='保持原思考设置续接一次';
  assert.match(requestStatus({phase:'connecting'},reason),/续接一次；正在连接/);
  assert.match(requestStatus({phase:'headers'},reason),/已响应，等待首段数据/);
  assert.match(requestStatus({phase:'waiting',elapsedMs:180000},reason),/已等待 3 分钟，可手动停止/);
  assert.match(requestStatus({phase:'first_body'},reason),/连接数据.*等待模型有效输出/);
  assert.match(requestStatus({phase:'progress'},reason),/有效增量/);
  assert.match(requestStatus({phase:'connecting'}),/^正在连接/);
});
