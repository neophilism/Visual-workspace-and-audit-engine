import {budgetBalance,verifyCostLedger} from '@accountability/resources';
import type {BudgetSnapshot} from '@accountability/resources/store';
import {manifestHash} from '@accountability/packaging-release';
import type {Binding,Manifest} from '@accountability/packaging-release';
import type {ReleaseSnapshot} from '@accountability/packaging-release/store';
import {canonical,digest,invariant,refKey,requireScope,validateRef} from './contracts.ts';
import type {Context,Json,Ref} from './contracts.ts';
import {layoutWorkspace} from './index.ts';
import type {VisualNode,VisualEvent,WorkspaceSnapshot,WorkStage} from './index.ts';
const json=(value:unknown):Json=>JSON.parse(canonical(value)) as Json;
function reference(c:Context,kind:string,id:string,revision:number):Ref{return validateRef({tenantId:c.tenantId,projectId:c.projectId,kind,id,revision});}
function finish(c:Context,title:string,nodes:VisualNode[],events:VisualEvent[]):WorkspaceSnapshot{
 const snapshot:WorkspaceSnapshot={tenantId:c.tenantId,projectId:c.projectId,schemaVersion:1,visibility:'private',title,capturedAt:c.now,nodes,events,agents:[]};layoutWorkspace(c,snapshot);return snapshot;
}
/** The authenticated host supplies an already-authorized, filtered snapshot and evidence-backed delivery stage. */
export function projectBudget(c:Context,input:BudgetSnapshot,stage:WorkStage):WorkspaceSnapshot{
 const {state,revision}=structuredClone(input);requireScope(c,state);invariant(verifyCostLedger(state),'invalid_ledger','Cost ledger hash chain is invalid');const balance=budgetBalance(state);const root=reference(c,'budget',state.id,revision);
 const nodes:VisualNode[]=[{ref:root,label:'Budget '+state.id,kind:'objective',state:balance.overLimit?'over-limit':'within-limit',stage,dependencies:[],summary:`${balance.spent} spent, ${balance.reserved} reserved, ${balance.available} available ${state.unit}`,details:json({budgetId:state.id,storageRevision:revision,unit:state.unit,balance,ledgerChainValid:true})}];
 const ids=new Set<string>();for(const r of state.reservations){invariant(!ids.has(r.id),'duplicate_reservation','Reservation identity duplicated');ids.add(r.id);if(r.receipt){validateRef(r.receipt);requireScope(c,r.receipt);}invariant(['held','committed','uncertain','settled','released'].includes(r.status),'invalid_reservation','Unknown reservation state');nodes.push({ref:reference(c,'budget-reservation',digest({budgetId:state.id,reservationId:r.id}),revision),label:r.id,kind:'task',state:r.status,stage,dependencies:[root],summary:r.status==='uncertain'?'Outcome unresolved; reservation remains allocated. Reconcile before another attempt.':`${r.units} ${state.unit} reserved for ${r.purpose}`,details:json({budgetId:state.id,storageRevision:revision,reservation:r})});}
 const events=state.entries.map(e=>({id:digest({budgetId:state.id,sequence:e.sequence,hash:e.hash}),at:e.at,actorId:e.actorId,action:e.type,resource:root,summary:`${e.units} ${state.unit}; ${e.reason??e.id}`}));return finish(c,'Private budget audit',nodes,events);
}
export function projectReleases(c:Context,input:ReleaseSnapshot,stage:WorkStage):WorkspaceSnapshot{
 const {state,revision}=structuredClone(input);requireScope(c,state);const root=reference(c,'release-control','private-release-control',revision);const byRef=new Map<string,VisualNode>();const hashes=new Map<string,string>();
 function addBinding(b:Binding,role:string):VisualNode{
  validateRef(b.ref);requireScope(c,b.ref);invariant(!['release-manifest','release-control'].includes(b.ref.kind),'reference_collision','Binding uses a reserved projection kind');invariant(/^[a-f0-9]{64}$/.test(b.sha256),'invalid_digest','Exact SHA256 required');const key=refKey(b.ref),old=byRef.get(key);invariant(!hashes.has(key)||hashes.get(key)===b.sha256,'conflicting_binding','The same edition has conflicting content hashes');hashes.set(key,b.sha256);
  if(old)return old;
  const node:VisualNode={ref:b.ref,label:b.ref.id,kind:role==='artifact'?'artifact':role==='source'?'source':'decision',state:'exact-bound-edition',stage,dependencies:[],summary:role+' edition referenced by the package; this projection does not grant permission.',details:json({binding:b})};byRef.set(key,node);return node;
 }
 const latest=new Map<string,Manifest>(),prior=new Map<string,Manifest>();const manifestKeys=new Set<string>();
 for(const m of state.manifests){
  const ref=reference(c,'release-manifest',m.id,m.revision),key=refKey(ref);invariant(!manifestKeys.has(key),'duplicate_manifest_edition','Manifest edition duplicated');manifestKeys.add(key);
  const previous=prior.get(m.id);invariant(previous?m.revision===previous.revision+1:m.revision===1,'manifest_history_gap','Manifest history must retain ordered consecutive editions');const dependencies:Ref[]=[];
  for(const artifact of m.artifacts){invariant(artifact.visibility==='private','invalid_projection','Only private artifact records may be projected');const a=addBinding(artifact,'artifact');const links=[...artifact.sourceBindings.map(b=>addBinding(b,'source').ref),addBinding(artifact.rightsDecision,'rights decision').ref,addBinding(artifact.consentDecision,'consent decision').ref,addBinding(artifact.editorialDecision,'editorial decision').ref];
   const unique=[...new Map(links.map(r=>[refKey(r),r])).values()];
   a.kind='artifact';a.summary='Exact private content edition. Source and decision bindings are specific to each manifest.';dependencies.push(a.ref,...unique);
  }
  if(previous)dependencies.push(reference(c,'release-manifest',previous.id,previous.revision));
  if(m.receipt)dependencies.push(addBinding(m.receipt,'receipt').ref);
  invariant(!byRef.has(key),'reference_collision','Manifest reference collides with another record');byRef.set(key,{ref,label:m.id+' · edition '+m.revision,kind:'decision',state:m.state,stage,dependencies:[...new Map(dependencies.map(r=>[refKey(r),r])).values()],summary:m.reason??'Package state is historical; current permissions require a new protected check.',details:json({storageRevision:revision,manifestHash:manifestHash(m),manifest:m})});prior.set(m.id,m);latest.set(m.id,m);
 }
 invariant(!byRef.has(refKey(root)),'reference_collision','Release control reference collides with another record');byRef.set(refKey(root),{ref:root,label:'Release control',kind:'objective',state:state.policy.externalEnabled?'external-policy-enabled':'publication-disabled',stage,dependencies:[...latest.values()].map(m=>reference(c,'release-manifest',m.id,m.revision)),summary:'Read-only private audit. This screen cannot publish, approve or withdraw anything.',details:json({storageRevision:revision,policy:state.policy,events:state.events})});
 const events=state.events.map(e=>({id:e.id,at:e.at,actorId:e.actorId,action:e.type,resource:root,summary:(e.manifestId?e.manifestId+': ':'')+(e.reason??e.type)}));return finish(c,'Private release audit',[...byRef.values()],events);
}
