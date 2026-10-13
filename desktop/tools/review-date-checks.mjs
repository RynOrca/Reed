export function reviewDateChecks(report) {
  const after=report.profileSnapshots?.['after-review-answer']?.learner;
  const restored=report.profileSnapshots?.['after-review-restart']?.learner;
  const item=after?.knowledge?.find(i=>i.subject==='特征分解');
  const event=after?.events?.findLast(e=>e.kind==='review'&&e.subject==='特征分解');
  const answer=report.cases?.find(c=>c.name==='learning-review-answer');
  const restart=report.cases?.find(c=>c.name==='learning-review-restart');
  const recalled=(restart?.toolResults||[]).filter(t=>!t.isError).flatMap(t=>(t.result?.content||[]).flatMap(block=>{
    if(block.type!=='text')return [];
    try{const value=JSON.parse(block.text);return Array.isArray(value)?value:[];}catch{return [];}
  }));
  return {
    storedDateSevenDays:!!event&&event.result==='independent'&&item?.nextReview===new Date(new Date(event.time).getTime()+7*86400000).toISOString(),
    dateReceiptMatchesStored:!!item?.nextReview&&!!answer?.toolResults?.some(t=>!t.isError&&t.result?.details?.receipt?.saved===true&&t.result.details.receipt.subject===item.subject&&t.result.details.receipt.nextReview===item.nextReview),
    restartDateUnchanged:!!item?.nextReview&&restored?.knowledge?.find(i=>i.subject===item.subject)?.nextReview===item.nextReview,
    restartToolReturnsSameDate:!!item?.nextReview&&!!restart?.toolStarts?.some(t=>t.name==='recall_memory'&&t.args?.area==='review')&&recalled.some(i=>i.subject===item.subject&&i.nextReview===item.nextReview),
  };
}
