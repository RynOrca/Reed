import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile,lstat,realpath,open} from 'node:fs/promises';
import {join,extname,basename} from 'node:path';
import {constants} from 'node:fs';
const title=value=>{if(typeof value!=='string'||!value.trim()||value.length>100)throw Error('名称须为 1 到 100 字符');return value.trim();};
const kinds=new Set(['textbook','past-paper','answer','notes']);
export class DocumentStore{
  constructor(root){this.root=join(root,'materials');this.dbPath=join(root,'materials.sqlite');}
  async database(){
    if(this.db)return this.db;
    await mkdir(this.root,{recursive:true});
    if(!this.db){this.db=new DatabaseSync(this.dbPath);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS subjects(id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS materials(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,path TEXT NOT NULL,page_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS material_pages(document_id TEXT NOT NULL,page_index INTEGER NOT NULL,text TEXT NOT NULL,method TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(document_id,page_index));
      CREATE VIRTUAL TABLE IF NOT EXISTS material_fts USING fts5(document_id UNINDEXED,page_index UNINDEXED,tokens);
      CREATE TABLE IF NOT EXISTS material_bindings(session_id TEXT PRIMARY KEY,subject_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS materials_subject ON materials(subject_id);
    `);}return this.db;
  }
  async subjects(workspace){return (await this.database()).prepare('SELECT id,title FROM subjects WHERE workspace=? ORDER BY title').all(workspace);}
  async createSubject(workspace,name){const id=randomUUID(),label=title(name),db=await this.database();db.prepare('INSERT INTO subjects VALUES(?,?,?)').run(id,label,workspace);return {id,title:label};}
  async subject(workspace,id){const row=(await this.database()).prepare('SELECT * FROM subjects WHERE id=? AND workspace=?').get(id,workspace);if(!row)throw Error('科目不属于当前项目');return row;}
  async bind(sessionId,workspace,subjectId){await this.subject(workspace,subjectId);(await this.database()).prepare('INSERT OR REPLACE INTO material_bindings VALUES(?,?)').run(sessionId,subjectId);return this.list(sessionId,workspace);}
  async binding(sessionId,workspace){return (await this.database()).prepare('SELECT s.* FROM subjects s JOIN material_bindings b ON b.subject_id=s.id WHERE b.session_id=? AND s.workspace=?').get(sessionId,workspace)||null;}
  async list(sessionId,workspace){const subject=await this.binding(sessionId,workspace);return {subject,documents:subject?(await this.database()).prepare('SELECT id,title,kind,hash,page_count AS pageCount FROM materials WHERE subject_id=? ORDER BY title').all(subject.id):[]};}
  async document(sessionId,workspace,id){const subject=await this.binding(sessionId,workspace);if(!subject)throw Error('请先选择当前科目');const doc=(await this.database()).prepare('SELECT * FROM materials WHERE id=? AND subject_id=?').get(id,subject.id);if(!doc)throw Error('资料不属于当前科目');return doc;}
  async importPdf(sessionId,workspace,path,{name,kind='textbook'}={}){
    const subject=await this.binding(sessionId,workspace);if(!subject)throw Error('请先新建或选择科目');if(!kinds.has(kind))throw Error('资料类型无效');
    const source=await realpath(path),info=await lstat(source);if(!info.isFile()||extname(source).toLowerCase()!=='.pdf'||info.size>128*1024*1024)throw Error('仅支持不超过 128 MB 的 PDF 文件');
    const bytes=await readFile(source);if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Error('文件不是有效 PDF');
    const hash=createHash('sha256').update(bytes).digest('hex'),db=await this.database();
    const duplicate=db.prepare('SELECT id FROM materials WHERE subject_id=? AND hash=? AND kind=?').get(subject.id,hash,kind);if(duplicate)return this.document(sessionId,workspace,duplicate.id);
    const id=randomUUID(),folder=join(this.root,subject.id+'-'+subject.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,50));await mkdir(folder,{recursive:true});
    const destination=join(folder,id+'.pdf');await writeFile(destination,bytes,{flag:'wx'});
    db.prepare('INSERT INTO materials VALUES(?,?,?,?,?,?,0)').run(id,subject.id,title(name||basename(source,'.pdf')),kind,hash,destination);
    return this.document(sessionId,workspace,id);
  }
  async bytes(sessionId,workspace,id,offset=0){const doc=await this.document(sessionId,workspace,id);if(!Number.isSafeInteger(offset)||offset<0)throw Error('文件读取位置无效');const file=await open(doc.path,'r');try{const size=(await file.stat()).size;if(offset>size)throw Error('读取位置超出文件');const buffer=Buffer.alloc(Math.min(1024*1024,size-offset));const {bytesRead}=await file.read(buffer,0,buffer.length,offset);return {data:buffer.subarray(0,bytesRead).toString('base64'),size,hash:doc.hash,nextOffset:offset+bytesRead};}finally{await file.close();}}
  async cachePage(sessionId,workspace,{documentId,revision,pageIndex,pageCount,text,method='text-layer'}){
    const doc=await this.document(sessionId,workspace,documentId);if(revision!==doc.hash)throw Error('资料版本已变化');
    if(!Number.isSafeInteger(pageIndex)||pageIndex<0||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>30000||pageIndex>=pageCount||typeof text!=='string'||text.length>100000||!['text-layer','mineru','ocr'].includes(method))throw Error('页面数据无效');
    const db=await this.database();db.exec('BEGIN IMMEDIATE');try{
      // A newly opened scanned page must not overwrite a better parsed page.
      const previous=db.prepare('SELECT method,text FROM material_pages WHERE document_id=? AND page_index=?').get(documentId,pageIndex);
      if(!(method==='text-layer'&&previous?.method!=='text-layer'&&previous?.text.length>text.length)){
        db.prepare('INSERT OR REPLACE INTO material_pages VALUES(?,?,?,?,?)').run(documentId,pageIndex,text,method,revision);
        db.prepare('DELETE FROM material_fts WHERE document_id=? AND page_index=?').run(documentId,pageIndex);
        const tokens=tokenize(text);db.prepare('INSERT INTO material_fts VALUES(?,?,?)').run(documentId,pageIndex,tokens.join(' '));
      }
      db.prepare('UPDATE materials SET page_count=? WHERE id=?').run(pageCount,documentId);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return this.page(sessionId,workspace,documentId,pageIndex);
  }
  async page(sessionId,workspace,id,index){const doc=await this.document(sessionId,workspace,id);if(!Number.isSafeInteger(index)||index<0||index>=doc.page_count)throw Error('PDF 页码无效');const page=(await this.database()).prepare('SELECT * FROM material_pages WHERE document_id=? AND page_index=?').get(id,index);return {...page,documentId:id,pageIndex:index,title:doc.title,hash:doc.hash,kind:doc.kind};}
  async snapshot(sessionId,workspace,input){
    if(!input?.readingVisible)return null;
    if(input.sessionId!==sessionId)throw Error('阅读位置来自其他会话，请重新打开资料');
    const doc=await this.document(sessionId,workspace,input.documentId);if(doc.kind==='answer')return null;
    const page=await this.page(sessionId,workspace,doc.id,input.pageIndex);if(input.revision!==doc.hash)throw Error('阅读位置已过期，请重新打开资料');
    const selectionText=typeof input.selectionText==='string'?input.selectionText.slice(0,4000):'';
    if(selectionText&&!(page.text||'').replace(/\s+/g,'').includes(selectionText.replace(/\s+/g,'')))throw Error('选区与页面不一致，请重新选择');
    return {sessionId,subjectId:doc.subject_id,documentId:doc.id,revision:doc.hash,pageIndex:page.pageIndex,title:doc.title,topicText:(page.text||'').slice(0,12000),selectionText,readingVisible:true,capturedAt:Number.isFinite(input.capturedAt)?Math.min(input.capturedAt,Date.now()):Date.now()};
  }
  async evidence(sessionId,workspace,scene,query){
    if(!scene)return [];
    const current=await this.page(sessionId,workspace,scene.documentId,scene.pageIndex);
    const items=[];
    if(scene.selectionText)items.push({id:`pdf:${scene.documentId}:${scene.pageIndex}:selection`,kind:'selection',label:`${scene.title} · PDF 第 ${scene.pageIndex+1} 页选区`,text:scene.selectionText,priority:110,required:true,url:`reed-material:${scene.documentId}#page=${scene.pageIndex+1}`});
    if(current.text?.trim())items.push({id:`pdf:${scene.documentId}:${scene.pageIndex}`,kind:'pdf',label:`${scene.title} · PDF 第 ${scene.pageIndex+1} 页`,text:current.text.slice(0,12000),priority:100,url:`reed-material:${scene.documentId}#page=${scene.pageIndex+1}`});
    else items.push({id:'pdf:unreadable',kind:'status',label:'扫描页',text:`当前阅读 ${scene.title} 的 PDF 第 ${scene.pageIndex+1} 页，尚无可读文字；不要猜测内容。可提示导入 MinerU 结果或识别这一页。`,priority:100});
    const prior=await this.search(sessionId,workspace,query,{documentId:scene.documentId,maxPage:scene.pageIndex});return [...items,...prior.filter(i=>i.id!==`pdf:${scene.documentId}:${scene.pageIndex}`)];
  }
  async search(sessionId,workspace,query,{documentId,maxPage=29999}={}){
    const subject=await this.binding(sessionId,workspace);if(!subject)return [];
    if(documentId)await this.document(sessionId,workspace,documentId);
    const words=tokenize(query).slice(0,30);if(!words.length)return [];
    const db=await this.database(),match=words.map(w=>'"'+w.replaceAll('"','""')+'"').join(' OR ');
    const rows=db.prepare(`SELECT m.id,m.title,p.page_index,p.text FROM material_fts f JOIN materials m ON m.id=f.document_id JOIN material_pages p ON p.document_id=m.id AND p.page_index=f.page_index
      WHERE material_fts MATCH ? AND m.subject_id=? AND m.kind!='answer' AND (? IS NULL OR m.id=?) AND p.page_index<=? ORDER BY bm25(material_fts) LIMIT 6`).all(match,subject.id,documentId||null,documentId||null,maxPage);
    return rows.map(r=>({id:`pdf:${r.id}:${r.page_index}`,kind:'pdf',label:`${r.title} · PDF 第 ${r.page_index+1} 页`,text:r.text.slice(0,1800),priority:75,url:`reed-material:${r.id}#page=${r.page_index+1}`}));
  }
  close(){this.db?.close();this.db=null;}
}
function tokenize(text){const s=String(text).normalize('NFKC').toLowerCase();return [...new Set([...(s.match(/[a-z0-9]+/g)||[]),...(s.match(/[\p{Script=Han}]+/gu)||[]).flatMap(s=>s.length<2?[s]:Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)))])];}
