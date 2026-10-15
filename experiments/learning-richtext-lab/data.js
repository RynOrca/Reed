/* Synthetic teaching material. No model calls or remote assets. */
window.ReedLabData = (() => {
  const text=(id,text)=>({id,type:'text',text});
  const choices=(id,title,options)=>({id,type:'choices',title,options:options.map(([label,replyText,feedback],i)=>({id:'option-'+i,label,replyText,feedback}))});
  const flow={id:'crypto-flow',type:'flow',title:'一次完整的加解密',nodes:[{label:'原始明文',value:'2',note:'m ∈ Z₁₅'},{label:'加密得到密文',value:'158',note:'公钥 (15, 16)，随机数 r = 2'},{label:'解密恢复明文',value:'2',note:'私钥 (λ, μ) = (4, 4)'}]};
  const comparison={id:'python-compare',type:'compare',title:'看起来相似，判断的是不同的事',columns:[{title:'if gcd(r, n)',label:'真值判断',body:'只检查最大公因数是否非零。对这里的正整数输入，gcd 总是正数，因此条件一直成立。',code:'gcd(6, 15) = 3 → True'},{title:'if gcd(r, n) == 1',label:'互素条件',body:'明确要求最大公因数等于 1，才说明 r 与 n 没有大于 1 的共同因子。',code:'gcd(6, 15) == 1 → False'}]};
  const results={id:'crypto-results',type:'result',title:'检查输入与输出',items:[{label:'加密前',value:'2',note:'原始明文'},{label:'传输中',value:'158',note:'随机密文'},{label:'解密后',value:'2',note:'恢复明文'}],conclusion:'恢复值与原始值一致。密文不是普通整数运算中的明文。'};
  const math={id:'mod-steps',type:'derivation',title:'把每一步依据放在结果旁边',steps:[{left:'32',operator:'=',right:'2 × 15 + 2',note:'先写成“商 × 模数 + 余数”。'},{left:'32 mod 15',operator:'=',right:'2',note:'模运算取余数，结果落在 0 到 14 之间。'},{left:'m',operator:'=',right:'2',note:'因此这里选择的消息代表元是 2。'}]};
  const code={id:'python-code',type:'code',language:'Python',title:'只改最关键的一行',lines:['from math import gcd','','def valid_random(r, n):','    if gcd(r, n) == 1:','        return r','    return None'],highlight:[4],annotation:'第 4 行：显式比较结果是否为 1。这里的函数只验证条件，不负责安全地生成随机数。'};
  const queryFlow={id:'search-flow',type:'flow',title:'笔记检索怎样回到原文',nodes:[{label:'先确定问题',value:'意图',note:'要找定义、例子还是边界？'},{label:'定位相关段落',value:'证据',note:'关键词和上下文一起判断'},{label:'组织解释',value:'回答',note:'关键结论附上来源'}]};
  const queryCompare={id:'search-compare',type:'compare',title:'摘要和引用分别解决什么问题',columns:[{label:'快速理解',title:'摘要',body:'压缩主要意思，帮助建立整体印象。',code:'我大概知道它讲什么。'},{label:'核对依据',title:'引用',body:'保留出处与原文位置，方便检查限定条件。',code:'我能回到原文确认。'}]};
  const gallery=[
    {id:'flow',name:'把过程，排成一条路径',kind:'FLOW',category:'关系',featured:true,description:'强调顺序、角色与数据如何变化。宽屏横排，窄屏自动转为纵向。',plain:'原始明文为 2。使用公钥 (15,16)、随机数 2 加密，密文为 158。再用私钥 (4,4) 解密，恢复明文 2。',why:'适合算法、因果链、数据转换；这个极小参数示例仅用于教学。',block:flow},
    {id:'compare',name:'并排看清两个条件',kind:'COMPARE',category:'关系',description:'每列沿用相同维度，让区别落在具体语义上。',plain:'if gcd(r,n) 判断结果是否非零；if gcd(r,n)==1 判断是否互素。对正整数，前者一直为真，后者才是需要的条件。',why:'适合概念区别、错误与修正；窄屏不强行挤成两列。',block:comparison},
    {id:'result',name:'让关键结果停留一秒',kind:'RESULT',category:'结果',description:'数值有标签、有依据，结论不只靠颜色。',plain:'加密前为 2，密文为 158，解密后为 2。恢复值与原始值一致。',why:'适合输入输出、不变量与检查结果。',block:results},
    {id:'derivation',name:'公式旁边，就是为什么',kind:'DERIVATION',category:'过程',description:'用浏览器原生 MathML 排版公式，逐步标出依据。',plain:'32 = 2 × 15 + 2，因此 32 mod 15 = 2，消息代表元 m = 2。',why:'适合短推导。公式与解释共同构成一个步骤。',block:math},
    {id:'code',name:'代码和解释，精确对齐',kind:'CODE',category:'过程',description:'保留缩进，只突出当前需要理解的关键行。',plain:'在 valid_random 函数中，如果 gcd(r,n)==1，则返回 r，否则返回 None。',why:'适合调试讲解；本原型不执行代码。',block:code},
    {id:'term',name:'术语解释留在阅读现场',kind:'ANNOTATION',category:'正文',description:'用户需要时展开，不强迫跳到另一个页面。',plain:'互素：两个整数的最大公因数为 1。互素不要求两个数都是质数，例如 8 与 15。',why:'适合第一次出现的术语、来源与适用条件。',block:{id:'term-example',type:'term',before:'选取随机数时，需要让 r 与 n ',term:'互素',after:'。这是一条关于两个数之间关系的条件。',definition:'两个整数的最大公因数为 1。例如 8 与 15 互素，但它们都不是质数。',source:'合成笔记 · 数论基础 / 互素定义'}},
    {id:'matrix',name:'概念、例子、边界一起读',kind:'MATRIX',category:'关系',description:'对齐三种信息，而不是把它们写成三个散落段落。',plain:'质数：例如 7，判断的是一个数。互素：例如 8 和 15，判断的是两个数的关系。两者不能互相替代。',why:'适合术语表、参数说明与条件整理。',block:{id:'concept-matrix',type:'matrix',headers:['概念','例子','要记住的边界'],rows:[['质数','7、11、13','一个数的性质'],['互素','8 与 15','两个数之间的关系'],['最大公因数','gcd(6,15)=3','计算共同因子中的最大值']]}},
    {id:'callout',name:'提示轻一点，条件清楚一点',kind:'CALLOUT',category:'正文',description:'用轻量的边线与留白，不让提示抢过正文。',plain:'注意：Python 中非零整数为真。“判断为真”和“满足互素条件”不是同一件事。',why:'适合易错点、适用条件、简化假设。',block:{id:'callout-group',type:'group',children:[{id:'condition-tip',type:'callout',title:'把条件写完整',text:'当要求最大公因数等于 1 时，直接写出 == 1，代码会更容易检查。',tone:'note'},{id:'condition-warning',type:'callout',title:'真值不等于正确性',text:'程序可以运行，只说明语法和执行路径成立；还需要核对它是否满足题目条件。',tone:'warning'}]}},
    {id:'chart',name:'小数据，也可以有一眼的比较',kind:'DATA',category:'结果',description:'表格保留精确数值，图形帮助观察大小。',plain:'合成评估中，关键词方案命中相关段落 8 条，标题方案 5 条，全文扫描 11 条。这里的数量不代表质量评分。',why:'适合比较可核对的数据；不用装饰图暗示不存在的精度。',block:{id:'sample-chart',type:'chart',title:'合成检索示例 · 相关段落数',rows:[{label:'关键词检索',value:8},{label:'标题检索',value:5},{label:'全文扫描',value:11}],caption:'人工构造的数据，仅演示表达。命中数量不等于答案质量。'}},
    {id:'timeline',name:'从尝试到理解，保留过程',kind:'TIMELINE',category:'过程',description:'强调阶段与转折，不把时间线当作任务进度条。',plain:'先手算一个例子，再写成程序，最后用边界输入检验。每一步都有不同的目的。',why:'适合实验记录、方法演变与学习回顾。',block:{id:'learning-timeline',type:'timeline',items:[{label:'第一步',title:'先算一个具体例子',text:'确认每一个中间量代表什么。'},{label:'第二步',title:'把推导写成程序',text:'将数学条件逐项翻译成代码判断。'},{label:'第三步',title:'再试一次边界输入',text:'检查一般情形之外，结论是否仍成立。'}]}},
    {id:'reveal',name:'先留一个线索',kind:'REVEAL',category:'正文',description:'提示由用户主动打开，思考的停顿也属于正文。',plain:'提示：先问 gcd 返回的是布尔值还是整数，再判断 Python 如何解释它。',why:'适合按需提示；默认不展开完整答案。',block:{id:'hint-example',type:'reveal',title:'卡住了？先看一个提示',text:'gcd 返回整数，不是布尔值。想一想：在 if 条件里，整数 3 会被当作什么？'}},
    {id:'choices',name:'选项，就是你的一句回答',kind:'QUICK REPLY',category:'回复',description:'点击后形成可见用户消息，继续当前问题。',plain:'你目前的运行情况是什么？可回复：成功且结果正确、运行报错、结果不符合预期，或者尚未运行。',why:'这是快捷回复，没有独立前端判题。下面反馈均为本地模拟。',block:choices('gallery-run','你的程序运行到哪一步了？',[
      ['成功，结果正确','这道互素条件练习我已运行，结果符合预期。','很好。再试试 r=6、n=15，说明为什么它应该被拒绝。'],
      ['运行报错','这道互素条件练习我运行后报错了。','把错误信息和对应代码发出来，我们从第一处异常开始检查。'],
      ['运行了，但结果不符','这道互素条件练习可以运行，但结果不符合预期。','先列出输入、实际输出与预期输出，再检查条件表达式。'],
      ['尚未运行','这道互素条件练习我尚未运行。','先在本地运行这个小例子，再告诉我实际结果。']])},
    {id:'reactive',name:'改变一个数，看见一句话变化',kind:'CANDIDATE',category:'候选',description:'正文中的轻量响应；作为实验候选，不纳入当前产品承诺。',plain:'如果每份笔记平均复习 5 分钟，那么 4 份笔记需要 20 分钟。这是固定算法估算，不是模型判断。',why:'借鉴 Tangle 的可探索正文；计算规则固定为 n×5。',block:{id:'time-estimate',type:'reactive',title:'今天有几份笔记要复习？',min:1,max:10,value:4,factor:5,unit:'份笔记',resultUnit:'分钟',note:'每份按 5 分钟估算，不代表你实际需要的学习时间。'}}
  ];
  const scenarios={
    python:{name:'Python 条件判断',subtitle:'代码 → 概念对比 → 尝试 → 反馈',question:'为什么我的 if gcd(r, n) 没有过滤掉不互素的数？',parts:[text('py-intro','这里要区分两件事：**Python 怎么判断真假**，以及**题目要求什么条件**。先看这一个关键位置。'),code,comparison,text('py-transition','我们检查一个具体输入。`r = 6`、`n = 15` 时，最大公因数是 **3**。'),choices('py-question','原来的 if gcd(r, n) 会不会进入分支？',[
      ['会，因为 3 是非零整数','对 gcd(6,15)=3，原来的 if gcd(r,n) 会进入分支，因为非零整数为真。','判断正确。现在把条件改成 gcd(r,n)==1：同样输入会被拒绝。再用自己的话说说，两种条件为什么不同？'],
      ['不会，因为它们不互素','我认为 gcd(6,15)=3 时，原来的条件不会进入分支，因为两个数不互素。','这里混淆了数学要求和 Python 真值。gcd 返回 3；Python 将非零整数当作真，因此原代码仍会进入分支。'],
      ['我还不确定','对于 gcd(6,15)=3，我还不确定 Python 会不会进入 if 分支。','先记住一条规则：整数 0 为假，非零整数为真。这里返回 3，所以会进入分支。']])]},
    crypto:{name:'模运算与加解密',subtitle:'公式 → 流程 → 结果 → 限定条件',question:'能用一个很小的例子，让我看清加密再解密的全过程吗？',parts:[text('crypto-intro','可以。先把消息放进模数的范围，再观察它在加解密过程中的变化。'),math,flow,results,{id:'crypto-assumption',type:'callout',tone:'warning',title:'这是极小参数教学示例',text:'Paillier 示例取 n=15、g=16、m=2、r=2。实际加密需要安全的大素数和密码学随机数，不能使用这些参数。'},choices('crypto-question','如果同一消息更换合法随机数，密文会怎样？',[
      ['可能变化，但仍解密回同一消息','同一消息更换合法随机数后，密文可能变化，但正确解密仍恢复同一消息。','对。随机性体现在密文中，解密正确性要求恢复相同消息。这解释了为什么不能靠密文数值直接猜明文。'],
      ['密文必须一直相同','我认为同一消息无论随机数如何变化，密文都应相同。','这是确定性加密的直觉。这个例子的加密式含 r 的项，改变合法随机数会影响密文；消息仍可正确恢复。']])]},
    retrieval:{name:'笔记检索与引用',subtitle:'问题 → 证据 → 对比 → 来源',question:'为什么笔记摘要里有这个结论，我还需要查看原文引用？',parts:[text('search-intro','摘要帮助你快速理解，而引用让你核对条件。我们先看一次回答如何从笔记里形成。'),queryFlow,queryCompare,{id:'source-term',type:'term',before:'回到原文，主要是为了检查结论的 ',term:'适用条件',after:'，包括前提、范围和例外。',definition:'例如“条件判断能过滤非法输入”需要明确哪一种输入、哪一个条件，以及判断发生在哪里。',source:'合成笔记 · 检索与证据 / 摘要的边界'},choices('search-question','看到一个重要结论后，你更希望先做什么？',[
      ['回到对应原文，核对前提','我想查看这条摘要对应的原文，核对它的前提和适用范围。','可以。真实 Reed 应定位到相关笔记段落。本原型使用合成来源，不打开你的真实笔记。'],
      ['先看一个具体反例','我想先看一个反例，理解这条结论何时不成立。','例如“检索返回更多段落，答案就更可靠”并不总成立。重复或不相关片段可能反而淹没关键依据。']])]}
  };
  const protocolExamples={python:{schemaVersion:1,title:'真值与互素',fallbackText:'gcd 返回整数。非零值为真，互素则需要结果等于 1。',parts:[text('protocol-intro','**同一个渲染器**可以呈现不同主题。下面的数据决定内容与组合。'),{id:'protocol-group',type:'group',children:[comparison,{id:'protocol-tip',type:'callout',tone:'note',title:'条件要对应目的',text:'把“结果非零”和“结果等于 1”区分开。'}]},scenarios.python.parts.at(-1)]},retrieval:{schemaVersion:1,title:'摘要与原文',fallbackText:'摘要用于理解，引用用于核对。',parts:[text('protocol-search-intro','同类流程和对比组件，也可以解释笔记检索。'),queryFlow,queryCompare,scenarios.retrieval.parts.at(-1)]},crypto:{schemaVersion:1,title:'模运算与加解密',fallbackText:'32 mod 15 = 2；加密后解密恢复原始明文。极小参数仅用于教学。',parts:[math,flow,results,scenarios.crypto.parts.at(-1)]}};
  const references=[
    {name:'json-render',description:'组件目录、结构化描述、数据驱动组合。参考如何让模型决定展示内容，让应用掌握呈现规则。',source:'https://github.com/vercel-labs/json-render',demo:'https://json-render.dev/examples'},
    {name:'A2UI',description:'组件描述、流式更新与动作回传。参考结构、数据和事件如何各司其职。',source:'https://github.com/a2ui-project/a2ui',demo:'https://a2ui.org/'},
    {name:'assistant-ui',description:'对话中的工具 UI 与生成组件。参考图解如何融入消息，而不是落入执行日志。',source:'https://github.com/assistant-ui/assistant-ui',demo:'https://www.assistant-ui.com/'},
    {name:'Streamdown',description:'面向流式正文的渲染。参考代码、数学、图表及中文阅读细节。',source:'https://github.com/vercel/streamdown',demo:'https://streamdown.ai/playground'},
    {name:'Idyll',description:'文章、组件和响应式变量。参考有叙事节奏的可探索解释。',source:'https://github.com/idyll-lang/idyll',demo:'https://idyll-lang.org/editor'},
    {name:'Observable',description:'正文与图形、网格和注释共存。参考轻量布局，不把所有信息都包成卡片。',source:'https://github.com/observablehq/framework',demo:'https://observablehq.github.io/framework/markdown'},
    {name:'Tangle',description:'正文中的可调变量。参考轻量操作如何帮助观察关系；本原型仅实现固定计算候选。',source:'https://github.com/worrydream/Tangle',demo:'https://worrydream.com/Tangle/'}
  ];
  return {gallery,scenarios,protocolExamples,references};
})();
