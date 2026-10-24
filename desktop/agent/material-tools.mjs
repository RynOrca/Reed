import {Type} from '@earendil-works/pi-ai';
import {defineTool} from '@earendil-works/pi-coding-agent';
export const MATERIAL_TOOLS=['search_context','read_evidence','create_practice_paper'];
export function materialTools({documents,currentSession,workspace,scene,createPaper}){
  return pi=>{
    if(createPaper)pi.registerTool(defineTool({name:'create_practice_paper',label:'生成练习卷',description:'仅当用户要求出题、组卷或模拟练习时调用。自动参考当前科目教材已读页与真题题型，使用当前模型独立生成新题并打开作答面板。参考答案不进入聊天。普通讲解不要调用；返回后让用户在试卷面板作答，不在聊天中解题或提前给答案。',parameters:Type.Object({count:Type.Integer({minimum:1,maximum:10}),topic:Type.String({maxLength:300}),type:Type.Union(['mixed','choice','short'].map(v=>Type.Literal(v)))}),async execute(_id,input){const paper=await createPaper(input);return {content:[{type:'text',text:JSON.stringify({paperId:paper.id,title:paper.title,message:'试卷已在学习资料面板打开，请用户独立作答，提交后显示解析。不要在聊天中提前作答。'})}]};}}));
    pi.registerTool(defineTool({name:'search_context',label:'查找学习资料',description:'在当前科目的授权教材和真题中查找相关片段。阅读时限定当前文档及当前页之前，不读答案资料。已有原文足够时不要重复检索。结果仅供参考，引用返回的 reed-material URL。',parameters:Type.Object({query:Type.String({minLength:1,maxLength:500})}),async execute(_id,{query}){
      const anchor=scene();const items=await documents.search(currentSession().sessionId,workspace(),query,anchor?{documentId:anchor.documentId,maxPage:anchor.pageIndex}:{});return {content:[{type:'text',text:JSON.stringify(items)}]};
    }}));
    pi.registerTool(defineTool({name:'read_evidence',label:'读取教材页',description:'按 1-based PDF 物理页码读取当前阅读文档中的指定页，仅能读取当前页及之前。长页按返回的 nextOffset 续读；若尚未提取文字，说明缺少原文，不猜测。',parameters:Type.Object({page:Type.Integer({minimum:1,maximum:30000}),offset:Type.Optional(Type.Integer({minimum:0,maximum:100000}))}),async execute(_id,{page,offset=0}){
      const anchor=scene();if(!anchor||page>anchor.pageIndex+1)throw Error('仅能读取当前教材已读页');
      const result=await documents.page(currentSession().sessionId,workspace(),anchor.documentId,page-1),body=result.text||'尚未提取此页文字，请用户打开该页或导入解析结果。';return {content:[{type:'text',text:JSON.stringify({title:result.title,page,text:body.slice(offset,offset+4000),totalChars:body.length,nextOffset:offset+4000<body.length?offset+4000:null,url:`reed-material:${anchor.documentId}#page=${page}`})}]};
    }}));
  };
}
