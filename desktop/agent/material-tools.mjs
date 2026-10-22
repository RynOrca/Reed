import {Type} from '@earendil-works/pi-ai';
import {defineTool} from '@earendil-works/pi-coding-agent';
export const MATERIAL_TOOLS=['search_context','read_evidence'];
export function materialTools({documents,currentSession,workspace,scene}){
  return pi=>{
    pi.registerTool(defineTool({name:'search_context',label:'查找学习资料',description:'在当前科目的授权教材和真题中查找相关片段。阅读时限定当前文档及当前页之前，不读答案资料。已有原文足够时不要重复检索。结果仅供参考，引用返回的 reed-material URL。',parameters:Type.Object({query:Type.String({minLength:1,maxLength:500})}),async execute(_id,{query}){
      const anchor=scene();const items=await documents.search(currentSession().sessionId,workspace(),query,anchor?{documentId:anchor.documentId,maxPage:anchor.pageIndex}:{});return {content:[{type:'text',text:JSON.stringify(items)}]};
    }}));
    pi.registerTool(defineTool({name:'read_evidence',label:'读取教材页',description:'按 1-based PDF 物理页码读取当前阅读文档中的指定页，仅能读取当前页及之前。若尚未提取该页文字，说明缺少原文，不猜测。',parameters:Type.Object({page:Type.Integer({minimum:1,maximum:30000})}),async execute(_id,{page}){
      const anchor=scene();if(!anchor||page>anchor.pageIndex+1)throw Error('仅能读取当前教材已读页');
      const result=await documents.page(currentSession().sessionId,workspace(),anchor.documentId,page-1);return {content:[{type:'text',text:JSON.stringify({title:result.title,page,text:(result.text||'尚未提取此页文字，请用户打开该页或导入解析结果。').slice(0,12000),url:`reed-material:${anchor.documentId}#page=${page}`})}]};
    }}));
  };
}
