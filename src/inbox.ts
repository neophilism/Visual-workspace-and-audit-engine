import {projectMail,projectThread} from '@accountability/correspondence';
import type {CorrespondenceState,MailView} from '@accountability/correspondence';
import {invariant,requireScope,validateRef} from './contracts.ts';
import type {Context} from './contracts.ts';
const views:readonly MailView[]=['inbox','unread','starred','drafts','sent','archive','all','trash','spam'];
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function projectInbox(context:Context,state:CorrespondenceState){
 // Upstream enforces human read permission and scope before exposing mailbox data.
 projectMail(state,context,{limit:1});
 invariant(state.threads.length<=500&&state.messages.length<=2000&&state.drafts.length<=1000,'projection_too_large','Inbox snapshot exceeds its private export budget');
 invariant(new Set(state.threads.map(t=>t.id)).size===state.threads.length,'duplicate_thread','Thread identity duplicated');
 const membership:Record<string,string[]>={};const ids=new Set<string>();
 for(const view of views){const found:string[]=[];let offset=0;for(;;){const page=projectMail(state,context,{view,offset,limit:100});for(const t of page.threads){found.push(t.id);ids.add(t.id);}if(page.nextOffset===null)break;offset=page.nextOffset;}membership[view]=found;}
 const threads=[...ids].map(id=>{
  const value=projectThread(state,context,id);
  const messages=value.messages.map(m=>{validateRef({tenantId:m.tenantId,projectId:m.projectId,kind:m.kind,id:m.id,revision:m.revision});requireScope(context,m);return{ref:{tenantId:m.tenantId,projectId:m.projectId,kind:m.kind,id:m.id,revision:m.revision},direction:m.direction,from:m.from,to:m.to,subject:m.subject,body:m.body,at:m.at,delivery:m.delivery,verification:m.direction==='inbound'?'unverified':null,policyAuthority:false};});
  const drafts=value.drafts.map(d=>({id:d.id,version:d.version,subject:d.subject,body:d.body,status:d.status,updatedAt:d.updatedAt}));
  const outcomes=state.intents.filter(i=>i.threadId===id).map(i=>({id:i.id,status:i.status,uncertainty:i.uncertainty}));
  return{thread:value.thread,messages,drafts,outcomes};
 });
 const snapshot={schemaVersion:1,visibility:'private',mailboxId:state.mailbox.id,brand:state.mailbox.brand,control:state.mailbox.control,revision:state.revision,capturedAt:context.now,membership,threads};
 invariant(Buffer.byteLength(JSON.stringify(snapshot))<=2*1024*1024,'projection_too_large','Inbox content exceeds its private export budget');return snapshot;
}
const client=String.raw`
const data=JSON.parse(document.getElementById('inbox-data').textContent), list=document.getElementById('threads'), detail=document.getElementById('conversation'), search=document.getElementById('search');
let view='inbox',selected=null;
function element(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function show(item){selected=item.thread.id;detail.replaceChildren();const header=element('header');header.append(element('h2',item.thread.subject),element('p','To: '+item.thread.recipient));header.append(element('p',item.thread.autonomyPaused?'Autonomous contact paused':'Thread control: '+data.control,'status'));detail.append(header);
 for(const message of item.messages){const article=element('article',undefined,'message');article.append(element('h3',message.subject),element('p',message.from+' → '+message.to),element('p',message.at+' · '+message.delivery,'meta'));if(message.direction==='inbound')article.append(element('strong','Attributed reply · unverified · no policy authority','unverified'));article.append(element('pre',message.body),element('small','Record '+message.ref.id+' · revision '+message.ref.revision));detail.append(article);}
 for(const draft of item.drafts){const article=element('article',undefined,'draft');article.append(element('h3','Draft: '+draft.subject),element('p',draft.status+' · version '+draft.version,'meta'),element('pre',draft.body));detail.append(article);}
 for(const outcome of item.outcomes)if(['queued','prepared','handed-off','uncertain'].includes(outcome.status))detail.append(element('p','Delivery '+outcome.status+(outcome.status==='uncertain'?' · reconcile before another attempt':''),'status'));
 document.querySelectorAll('[data-thread]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.thread===selected)));
}
function render(){const query=search.value.trim().toLowerCase(),allowed=new Set(data.membership[view]);const rows=data.threads.filter(item=>allowed.has(item.thread.id)&&[item.thread.subject,item.thread.recipient,...item.messages.flatMap(m=>[m.subject,m.body,m.from]),...item.drafts.flatMap(d=>[d.subject,d.body])].join('
').toLowerCase().includes(query)).sort((a,b)=>b.thread.lastActivityAt.localeCompare(a.thread.lastActivityAt)||a.thread.id.localeCompare(b.thread.id));list.replaceChildren();
 for(const item of rows){const button=element('button',undefined,'thread '+(item.thread.read?'read':'unread'));button.type='button';button.dataset.thread=item.thread.id;button.setAttribute('aria-pressed',String(selected===item.thread.id));button.append(element('strong',item.thread.subject),element('span',item.thread.recipient),element('small',item.thread.lastActivityAt+(item.thread.starred?' · Starred':'')));button.onclick=()=>show(item);list.append(button);}
 document.getElementById('result-status').textContent=rows.length+' conversations · '+view+' · snapshot revision '+data.revision;
 if(!rows.some(item=>item.thread.id===selected)){selected=null;detail.replaceChildren(element('p',rows.length?'Select a conversation to review messages and drafts.':'No conversations match this view.'));}
 document.querySelectorAll('[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===view)));
}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{view=button.dataset.view;render();});search.addEventListener('input',render);render();
`;
export function renderInbox(context:Context,state:CorrespondenceState):string{
 const snapshot=projectInbox(context,state),data=JSON.stringify(snapshot).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(snapshot.brand)} · Private inbox</title><style>body{margin:0;font:15px system-ui;color:#163b34;background:#eef4f1}body>header{background:#173d35;color:white;padding:20px 4%}h1{font-size:24px;margin:6px 0}main{padding:20px 4%}.workspace{display:grid;grid-template-columns:150px minmax(240px,1fr) minmax(300px,2fr);gap:16px}nav,section{min-width:0;background:white;border:1px solid #ccdcd2;border-radius:10px;padding:14px}nav button{width:100%;margin-bottom:5px;text-transform:capitalize}button{font:inherit;border:1px solid #bfd4c7;background:#f4f8f5;color:#173d35;border-radius:7px;padding:10px;cursor:pointer;text-align:left}button[aria-pressed=true]{background:#dceee3;border-color:#2b7151}button:focus-visible,input:focus-visible{outline:3px solid #b17914}.thread{display:block;width:100%;margin-bottom:9px;overflow-wrap:anywhere}.thread span,.thread small{display:block;margin-top:5px}.thread.unread strong{font-weight:800}.thread.read strong{font-weight:500}small,.meta{font-size:12px;color:#4c6b5e}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}article{border-top:1px solid #ccdcd2;padding:15px 0}.draft{border-left:4px solid #b08026;padding-left:12px}.status,.unverified{background:#f5edd9;padding:9px;display:block}.tools{margin-bottom:16px}input{font:inherit;width:min(500px,90%);padding:12px;border:1px solid #a5c1b0;border-radius:8px}#conversation{overflow-wrap:anywhere}#result-status{font-size:13px}@media(max-width:900px){.workspace{grid-template-columns:130px 1fr}#conversation{grid-column:1/-1}}@media(max-width:550px){.workspace{grid-template-columns:1fr}nav{display:flex;flex-wrap:wrap;gap:5px}nav button{width:auto;margin:0}#conversation{grid-column:auto}}</style></head><body><header><small style="color:#d7e7dc">PRIVATE · READ-ONLY SNAPSHOT</small><h1>${escape(snapshot.brand)}</h1><p>Mailbox control: ${escape(snapshot.control)} · Captured ${escape(snapshot.capturedAt)}</p></header><main><div class="tools"><label for="search">Search conversations</label><br><input id="search" type="search" maxlength="200" autocomplete="off"><p id="result-status" role="status" aria-live="polite"></p></div><div class="workspace"><nav aria-label="Mail folders">${views.map(view=>`<button type="button" data-view="${view}" aria-pressed="false">${view==='all'?'All mail':view}</button>`).join('')}</nav><section aria-label="Conversation list" id="threads"></section><section aria-label="Conversation" id="conversation" tabindex="0"></section></div></main><script id="inbox-data" type="application/json">${data}</script><script>${client}</script></body></html>`;
}
