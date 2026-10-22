import {icon} from './icons.js';
export const materialKind={textbook:'教材','past-paper':'历年真题',answer:'答案与解析',notes:'补充资料'};
export function materialMarkup(){return `
<header class="materials-toolbar">
 <button type="button" class="materials-document-trigger" data-m="library-toggle" aria-label="切换科目或资料" aria-expanded="false"><span data-icon="folder"></span><span data-m="title">学习资料</span><span data-icon="chevron" class="materials-caret"></span></button>
 <nav class="materials-tabs" aria-label="资料工作区"><button type="button" data-m="read-tab" aria-current="page">阅读</button><button type="button" data-m="practice-tab">练习</button></nav>
 <div class="materials-reading-tools"><button type="button" data-m="prev" aria-label="上一页" title="上一页"><span data-icon="chevron" class="materials-previous"></span></button><input data-m="page" type="number" min="1" value="1" aria-label="PDF 页码"><span data-m="count"></span><button type="button" data-m="next" aria-label="下一页" title="下一页"><span data-icon="chevron"></span></button><span class="materials-tool-rule"></span><button type="button" data-m="zoom-out" aria-label="缩小" title="缩小"><span data-icon="hide"></span></button><input data-m="zoom" value="100%" aria-label="缩放比例"><button type="button" data-m="zoom-in" aria-label="放大" title="放大"><span data-icon="new"></span></button><select data-m="fit" aria-label="页面适配"><option value="width">适应宽度</option><option value="page">整页显示</option><option value="custom">自定比例</option></select></div>
 <button type="button" data-m="more-toggle" class="materials-more-trigger" aria-label="更多文档操作" aria-expanded="false">···</button><button type="button" data-m="close" aria-label="关闭学习资料" title="关闭学习资料"><span data-icon="close"></span></button>
</header>
<div class="materials-menu-scrim" data-m="scrim" hidden></div>
<aside class="materials-library" data-m="library" aria-label="资料导航" hidden>
 <header><strong>选择学习资料</strong><button type="button" data-m="library-close" aria-label="关闭资料面板"><span data-icon="close"></span></button></header>
 <label>科目与资料</label><div class="materials-subject-row"><select data-m="subjects" aria-label="当前科目"></select><button type="button" data-m="new" aria-label="新建科目" title="新建科目"><span data-icon="new"></span></button></div>
 <div class="materials-list-heading"><span>教材与资料</span><button type="button" data-m="import" aria-label="导入 PDF" title="导入 PDF"><span data-icon="new"></span></button></div><div data-m="document-list" class="materials-document-list"></div>
 <select data-m="documents" aria-label="当前资料" hidden></select><button type="button" data-m="bank-import" class="materials-library-link"><span data-icon="folder"></span>导入题库</button><button type="button" data-m="library-practice" class="materials-library-link"><span data-icon="activity"></span>练习与试卷</button>
 <button type="button" data-m="library-import" class="materials-outline"><span data-icon="new"></span>导入学习资料</button><small>资料保存在本机</small>
</aside>
<div class="materials-more-menu" data-m="more" hidden><button type="button" data-m="parsed">导入 MinerU 解析结果</button><button type="button" data-m="ocr">识别当前页文字</button><hr><button type="button" data-m="fit-width">适应宽度</button><button type="button" data-m="fit-page">整页显示</button><button type="button" data-m="retry">重新读取本页</button></div>
<div class="materials-reader" data-m="reader" tabindex="0" aria-label="PDF 阅读区"></div>
<div class="materials-page-notice" data-m="notice"><span data-m="notice-title">让学习，从一份教材开始</span><p data-m="notice-copy">新建科目后导入教材或真题，阅读、提问与练习都在这里。</p><button type="button" data-m="notice-action" class="materials-primary">选择学习资料</button></div>
<div class="materials-loading" data-m="loading" hidden>正在读取本页，保留当前画面…</div>
<section data-m="practice" class="materials-practice" hidden></section><section data-m="assessment" class="materials-assessment" hidden></section>
<footer class="materials-footer"><span class="materials-status" data-m="status" role="status">选择科目与教材，开始阅读。</span><span data-m="page-status"></span><button type="button" data-m="back-chat">返回对话</button></footer>`;}
export function hydrateMaterialIcons(root){for(const node of root.querySelectorAll('[data-icon]'))node.replaceChildren(icon(node.dataset.icon));}
