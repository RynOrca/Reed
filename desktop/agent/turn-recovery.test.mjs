import test from "node:test";
import assert from "node:assert/strict";
import { createTurnRecovery, summarizeRequest } from "./turn-recovery.mjs";

const privateSystem = "PRIVATE_SYSTEM_SENTINEL";
const privateUser = "PRIVATE_USER_SENTINEL";
const privateCredential = "PRIVATE_CREDENTIAL_SENTINEL";
const thinkingOnly = {
  role: "assistant", stopReason: "length",
  content: [{ type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" }],
  usage: { input: 100, output: 20, totalTokens: 120 },
};

test("malformed SSE recovery excludes visible answers, tool calls, aborts and unrelated errors", () => {
  const recovery = createTurnRecovery({ send() {} });
  recovery.begin();
  const malformed = { ...thinkingOnly, stopReason: "error", errorMessage: "Error reading response: malformed server-sent event JSON." };
  assert.equal(recovery.willRecover(malformed), true);
  assert.equal(recovery.willRecover({ ...malformed, content: [{ type: "text", text: "partial answer" }] }), false);
  assert.equal(recovery.willRecover({ ...malformed, content: [{ type: "toolCall", name: "write" }] }), false);
  assert.equal(recovery.willRecover({ ...malformed, stopReason: "aborted" }), false);
  assert.equal(recovery.willRecover({ ...malformed, errorMessage: "401 invalid API key" }), false);
  assert.equal(recovery.willRecover({ ...malformed, errorMessage: "503 model startup failed" }), false);
});

const cases = [
  {name:'Qwen toggles and budget',payload:{enable_thinking:true,chat_template_kwargs:{enable_thinking:true,preserved:7},thinking_budget:8192}},
  {name:'DeepSeek thinking',payload:{thinking:{type:'enabled'}}},
  {name:'Anthropic budget and effort',payload:{thinking:{type:'enabled',budget_tokens:8192},output_config:{effort:'medium',preserved:7},system:[{type:'text',text:privateSystem}]}},
  {name:'Anthropic adaptive thinking',payload:{thinking:{type:'adaptive'},output_config:{effort:'medium'},system:privateSystem}},
  {name:'Responses string input',payload:{reasoning:{effort:'medium',summary:'auto'},instructions:privateSystem,input:privateUser,max_output_tokens:8192}},
  {name:'Chat completions effort',payload:{reasoning_effort:'medium',max_completion_tokens:16384}},
];

for (const scenario of cases) {
  test(`public recovery extension adapts ${scenario.name} without persisting changes`, async () => {
    const handlers = new Map(), diagnostics = [], events = [];
    const recovery = createTurnRecovery({ send: event => events.push(event), diagnostic: async event => diagnostics.push(event) });
    recovery.extension({ on: (type, callback) => handlers.set(type, callback) });
    const payload = {
      model: "isolated-model", messages: [{ role: "system", content: privateSystem }, { role: "user", content: privateUser }],
      api_key: privateCredential, headers: { authorization: privateCredential }, ...scenario.payload,
    };
    if ("input" in scenario.payload) delete payload.messages;
    const snapshot = structuredClone(payload);
    recovery.begin();
    assert.strictEqual(await handlers.get("before_provider_request")({ payload }), payload);
    const boundary = await handlers.get("turn_end")({ message: thinkingOnly, messageEntryId: "isolated-failure" });
    assert.equal(boundary.continue,true);
    assert.deepEqual(boundary.entries[0],{type:'context_edit',targetId:'isolated-failure',replacement:null});
    assert.equal(boundary.entries[1].customType,'reed_model_continuation');
    const lowered = await handlers.get("before_provider_request")({ payload });
    assert.strictEqual(lowered,payload,'续接不得改变原始请求任何字段');
    assert.deepEqual(payload, snapshot, "重试不得修改调用方的原始请求对象或嵌套字段");
    assert.strictEqual(await handlers.get("before_provider_request")({ payload }), payload, "后续工具轮同样保持请求字段不变");
    const secondBoundary = await handlers.get("turn_end")({ message: thinkingOnly, messageEntryId: "isolated-second-failure" });
    assert.equal(secondBoundary.continue, false);
    assert.equal(events.filter(event => event.type === "recovery").length, 1);
    recovery.end();
    recovery.begin();
    assert.strictEqual(await handlers.get("before_provider_request")({ payload }), payload, "新用户轮恢复原始思考设置");
    const diagnosticText = JSON.stringify(diagnostics);
    for (const secret of [privateSystem, privateUser, privateCredential, "PRIVATE_REASONING_SENTINEL"]) {
      assert.ok(!diagnosticText.includes(secret), "诊断不能包含提示词、正文、思考或凭据");
    }
    assert.equal(diagnostics.filter(event => event.type === "request")[1].recovery, true);
    assert.equal(diagnostics.at(-1).recovery, false);
    assert.equal(diagnostics.at(-1).request, 1);
  });
}

test("request summary accepts Responses string input and exposes only user length and hash", () => {
  const summary = summarizeRequest({ model: "isolated", instructions: privateSystem, input: privateUser, api_key: privateCredential });
  assert.equal(summary.userMessages.length, 1);
  assert.equal(summary.userMessages[0].length, privateUser.length);
  assert.match(summary.userMessages[0].hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(summary).includes(privateUser));
});

test('completed thinking-only stop is retained and continuation is bounded, cancellation never resumes',async()=>{
  const handlers=new Map(),events=[];
  const recovery=createTurnRecovery({send:e=>events.push(e)});
  recovery.extension({on:(name,fn)=>handlers.set(name,fn)});recovery.begin();
  const message={...thinkingOnly,stopReason:'stop'};
  const boundary=await handlers.get('turn_end')({message,messageEntryId:'complete-thinking'});
  assert.equal(boundary.entries.length,1);
  assert.equal(boundary.entries[0].type,'custom_message');
  assert.equal(boundary.entries[0].details.preserveThinking,true);
  assert.ok(!/降低|降档/.test(events[0].message));
  await handlers.get('before_provider_request')({payload:{}});
  assert.equal(await handlers.get('turn_end')({message,messageEntryId:'second'}),undefined);
  assert.equal(events.length,1);
  recovery.end();assert.equal(recovery.willRecover(message),false);
  recovery.begin();assert.equal(await handlers.get('turn_end')({message:{...message,stopReason:'aborted'},messageEntryId:'cancelled'}),undefined);
});

test('malformed tool placeholder is a failure with explicit non-execution guidance',()=>{
  const handlers=new Map();createTurnRecovery({send(){}}).extension({on:(name,fn)=>handlers.set(name,fn)});
  const result=handlers.get('tool_result')({toolName:'malformed_tool_call',input:{error:'output ended before tool call closed'}});
  assert.equal(result.isError,true);
  assert.match(result.content[0].text,/未执行/);
  assert.match(result.content[0].text,/output ended/);
  assert.equal(handlers.get('tool_result')({toolName:'read'}),undefined);
});

test('a late old-attempt terminal event cannot schedule recovery or replace the new turn outcome',async()=>{
  const handlers=new Map(),events=[];
  const recovery=createTurnRecovery({send:e=>events.push(e),currentAttempt:()=> 'new'});
  recovery.extension({on:(name,fn)=>handlers.set(name,fn)});recovery.begin();
  const message={...thinkingOnly,reedWire:{attempt_id:'old'}};
  assert.equal(recovery.willRecover(message),false);
  assert.equal(await handlers.get('turn_end')({message,messageEntryId:'old'}),undefined);
  assert.equal(events.length,0);
});

test('a stopped thinking loop asks for one concrete action and never replays the loop',async()=>{
  const handlers=new Map(),events=[];
  const recovery=createTurnRecovery({send:e=>events.push(e)});
  recovery.extension({on:(name,fn)=>handlers.set(name,fn)});
  for(const code of ['thinking_repetition','thinking_budget']){
    recovery.begin();
    const message={...thinkingOnly,stopReason:'error',errorMessage:`Reed model protocol: ${code}`,
      reedWire:{enforced:true,errorCode:code,status:'incomplete',transportComplete:false}};
    const boundary=await handlers.get('turn_end')({message,messageEntryId:code});
    assert.equal(boundary.continue,true);
    assert.equal(boundary.entries[0].type,'context_edit','退化的思考不重放');
    assert.equal(boundary.entries[1].customType,'reed_model_continuation');
    assert.match(boundary.entries[1].content,/Immediately perform the smallest concrete step/);
    assert.doesNotMatch(boundary.entries[1].content,/Preserve the configured reasoning depth/,'停下来的是计划，不该再要求保持原思考深度');
    assert.equal(boundary.entries[1].details.preserveThinking,false);
    assert.equal(boundary.entries[1].details.code,code);
    const second=await handlers.get('turn_end')({message,messageEntryId:`${code}-second`});
    assert.notEqual(second?.continue,true,'同一轮只推一次');
    assert.equal(second.entries?.[0]?.type,'context_edit','再次失败只丢弃该条尝试，不再续接');
  }
  assert.equal(events.length,2);
  assert.match(events[0].message,/立即执行/);
  assert.match(events[1].message,/立即执行/);
});
