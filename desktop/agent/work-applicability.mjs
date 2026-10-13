const known = ['powershell-legacy','powershell-core','powershell-unknown','bash','zsh','cmd'];
export function shellEnvironment(value) {
  const text=String(value||'').toLowerCase().trim();
  if(known.includes(text))return text;
  const families=new Set();
  if(/windows[- ]powershell|powershell\s*(?:v)?5(?:\.1)?|ps\s*5\.1/.test(text))families.add('powershell-legacy');
  if(/\bpwsh\b|powershell\s*(?:v)?[7-9](?:\.|\b)|powershell core/.test(text))families.add('powershell-core');
  for(const name of ['bash','zsh','cmd'])if(new RegExp(`\\b${name}\\b`).test(text))families.add(name);
  if(!families.size&&/powershell/.test(text))families.add('powershell-unknown');
  return families.size===1?[...families][0]:null;
}

// Tool discovery describes available environments, not the environment selected by this task.
export function workEnvironmentHint(prompt,messages=[]) {
  const explicit=shellEnvironment(prompt);
  if(explicit&&explicit!=='powershell-unknown')return explicit;
  const turn=messages.findLastIndex(m=>m.role==='user');
  for(const message of messages.slice(turn+1).reverse()){
    if(message.role!=='assistant')continue;
    for(const block of [...(Array.isArray(message.content)?message.content:[])].reverse()){
      if(block.type!=='toolCall'||!['mcp_call','bash','powershell'].includes(block.name))continue;
      const input=block.arguments||{};
      const hint=shellEnvironment(input.arguments?.shell||input.shell||(block.name==='bash'?'bash':''));
      if(hint)return hint;
    }
  }
  // Carry environment only when the user explicitly continues a task and a prior result proves execution.
  if(/^(?:请)?(?:继续|接着|再试|continue\b|try again\b)/i.test(String(prompt).trim())){
    for(const message of messages.slice(0,turn).reverse().slice(0,16)){
      if(message.role!=='toolResult'||!['mcp_call','bash','powershell'].includes(message.toolName))continue;
      const results=[message.structuredContent];
      for(const block of Array.isArray(message.content)?message.content:[]){if(block.type==='text')try{results.push(JSON.parse(block.text));}catch{}}
      for(const result of results){
        if(!result||message.isError||(result.exitCode??result.exit_code)!==0)continue;
        const hint=shellEnvironment(result.shell);
        if(hint)return hint;
      }
    }
  }
  return explicit;
}

export function applicableWork(item,hint) {
  const current=shellEnvironment(hint);
  if(!current)return true;
  const observed=[...new Set((item.evidenceRefs||[]).map(r=>shellEnvironment(r.shell)).filter(Boolean))];
  if(observed.length>1)return false;
  const saved=observed.length===1?observed[0]:shellEnvironment(item.environment)||shellEnvironment(item.title+' '+item.body);
  if(!saved)return true;
  if(current==='powershell-unknown')return saved.startsWith('powershell-');
  if(saved==='powershell-unknown')return current.startsWith('powershell-');
  return saved===current;
}
