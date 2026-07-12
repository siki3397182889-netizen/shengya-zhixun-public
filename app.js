import { loadEngine } from "./engine.js";

const state={mode:"sample",engine:null,result:null,file:null};
const el=(id)=>document.getElementById(id);
const statusClass={"正常":"normal","需复核":"review","异常":"abnormal","规则不足":"insufficient"};
const dimensionNames={completeness:"数据完整性",compliance:"规则符合度",closure:"闭环完整性",traceability:"依据可追溯性"};

function toast(message){el("toast").textContent=message;el("toast").classList.add("show");setTimeout(()=>el("toast").classList.remove("show"),1800);}
function mode(value){state.mode=value;document.querySelectorAll(".mode-tab").forEach((b)=>b.classList.toggle("active",b.dataset.mode===value));el("sampleMode").classList.toggle("hidden",value!=="sample");el("uploadMode").classList.toggle("hidden",value!=="upload");}
function sampleNote(){el("sampleDescription").textContent=state.engine.samples.find((s)=>s.id===el("sampleSelect").value)?.description||"";}
function workbookCell(cell){const value=cell.value;if(value==null)return null;if(value instanceof Date)return value.toISOString();if(typeof value==="object"){if("result"in value)return value.result??null;if("text"in value)return value.text;if(Array.isArray(value.richText))return value.richText.map((r)=>r.text).join("");return String(cell.text||"");}return value;}
async function parseWorkbook(file){
  if(!file.name.toLowerCase().endsWith(".xlsx"))throw new Error("仅支持.xlsx文件");
  if(file.size>5*1024*1024)throw new Error("文件超过5MB限制");
  if(!globalThis.ExcelJS)throw new Error("Excel解析组件未加载");
  const workbook=new globalThis.ExcelJS.Workbook();await workbook.xlsx.load(await file.arrayBuffer());
  const sheet=workbook.getWorksheet("sheet1")||workbook.worksheets[0];
  if(!sheet||sheet.rowCount<2)throw new Error("工作簿没有可读取的巡检记录");
  const headers=Array.from({length:sheet.columnCount},(_,i)=>String(workbookCell(sheet.getCell(1,i+1))??"").trim());
  const rows=[];
  for(let n=2;n<=sheet.rowCount;n++){const row=Array.from({length:sheet.columnCount},(_,i)=>workbookCell(sheet.getCell(n,i+1)));if(row.some((v)=>v!==null&&v!==""))rows.push(row);}
  if(rows.length>500)throw new Error("记录数超过500条限制");
  return{fileName:file.name,headers,rows};
}
function metric(label,value){const n=document.createElement("div");n.className="metric";const s=document.createElement("strong");s.textContent=String(value);const l=document.createElement("span");l.textContent=label;n.append(s,l);return n;}
function list(container,items){container.replaceChildren(...items.map((x)=>{const li=document.createElement("li");li.textContent=x;return li;}));}
function renderChecks(items){el("checksList").replaceChildren(...items.map((item)=>{const a=document.createElement("article");a.className="check";const b=document.createElement("span");b.className="check-status "+item.status;b.textContent=item.status;const m=document.createElement("div");m.className="check-main";const t=document.createElement("strong");t.textContent=item.title;const d=document.createElement("p");d.textContent=item.detail;m.append(t,d);const f=document.createElement("div");f.className="check-fact";f.textContent=[item.observed!==null?"观测 "+item.observed:"",item.threshold!==null?"边界 "+item.threshold:"",item.unit||"",item.ruleId?"规则 "+item.ruleId:""].filter(Boolean).join(" · ");a.append(b,m,f);return a;}));}
function renderScore(score){
  el("scoreValue").textContent=score.total;el("scoreGrade").textContent=score.grade+"级 · "+score.level;el("scoreNote").textContent=score.note;
  el("scoreDimensions").replaceChildren(...Object.entries(score.dimensions).map(([key,value])=>{const node=document.createElement("div");const head=document.createElement("div");head.className="dimension-head";const name=document.createElement("span");name.textContent=dimensionNames[key];const val=document.createElement("b");val.textContent=value+" / "+score.maxima[key];head.append(name,val);const track=document.createElement("div");track.className="dimension-track";const fill=document.createElement("div");fill.className="dimension-fill";fill.style.width=Math.round(value/score.maxima[key]*100)+"%";track.append(fill);node.append(head,track);return node;}));
}
function renderCitations(result){
  const hits=result.knowledgeHits?.length?result.knowledgeHits:result.citations;
  el("citationsList").replaceChildren(...hits.map((item)=>{const n=document.createElement("div");n.className="citation";const s=document.createElement("strong");s.textContent=(item.id||item.ruleId)+"｜"+(item.title||item.sourceLabel);const p=document.createElement("span");p.textContent=(item.snippet||item.sourceLocator||"")+"｜"+(item.sourceLabel||item.requiredAction||"");n.append(s,p);return n;}));
}
function renderEhs(value){const card=el("ehsCard");card.replaceChildren();const h=document.createElement("h3");h.textContent="EHS时限提醒";const p=document.createElement("p");p.textContent=value.message;card.append(h,p);if(value.steps){const ul=document.createElement("ul");value.steps.forEach((x)=>{const li=document.createElement("li");li.textContent=x;ul.append(li);});card.append(ul);}}
function render(result){
  state.result=result;el("emptyState").classList.add("hidden");el("loadingState").classList.add("hidden");el("resultState").classList.remove("hidden");
  el("resultTitle").textContent=(result.summary.formNo||"未知表单")+" · "+result.summary.formName;el("overallStatus").textContent=result.status;el("overallStatus").className="status-pill "+statusClass[result.status];
  renderScore(result.score);el("metricGrid").replaceChildren(metric("记录数",result.summary.recordCount),metric("巡检字段",result.summary.fieldCount),metric("正常",result.summary.normalCount),metric("需复核",result.summary.reviewCount),metric("异常",result.summary.abnormalCount));
  el("confidenceLabel").textContent="总体置信度："+result.confidence;renderChecks(result.checks);list(el("questionsList"),result.clarifyingQuestions.length?result.clarifyingQuestions:["无额外复核问题"]);list(el("closureList"),result.closureChecklist);el("defectDraft").textContent=result.defectDraft;renderEhs(result.ehsEscalation);renderCitations(result);el("engineNote").textContent=result.modelNote;el("resultState").scrollIntoView({behavior:"smooth",block:"start"});
}
async function analyze(){
  const button=el("analyzeButton");button.disabled=true;el("emptyState").classList.add("hidden");el("resultState").classList.add("hidden");el("loadingState").classList.remove("hidden");
  try{let input,source;if(state.mode==="sample"){const sample=state.engine.samples.find((s)=>s.id===el("sampleSelect").value);input={...sample,fileName:sample.id+".xlsx"};source="sample:"+sample.id;}else{if(!state.file)throw new Error("请先选择一个XLSX文件");input=await parseWorkbook(state.file);source="upload:local-browser";}render(state.engine.analyze(input,{source,ehsLevel:el("ehsLevel").value||null}));}catch(error){el("loadingState").classList.add("hidden");el("emptyState").classList.remove("hidden");toast(error.message);}finally{button.disabled=false;}
}
function knowledgeSearch(){
  const hits=state.engine.searchKnowledge(el("knowledgeQuery").value,5);
  el("knowledgeResults").replaceChildren(...(hits.length?hits:[{title:"未检索到匹配规则",snippet:"请尝试设备名称、表单编号、字段或阈值。"}]).map((hit)=>{const n=document.createElement("div");n.className="mini-hit";const s=document.createElement("strong");s.textContent=hit.title;const p=document.createElement("span");p.textContent=hit.snippet;n.append(s,p);return n;}));
}
function download(name,type,content){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function report(r){return["升压智巡｜公开无密钥版复核报告","表单："+(r.summary.formNo||"未知")+" "+r.summary.formName,"结论："+r.status+"｜评分："+r.score.total+"（"+r.score.grade+"级）｜置信度："+r.confidence,"","检查明细：",...r.checks.map((x,i)=>(i+1)+". ["+x.status+"] "+x.title+"｜观测："+(x.observed??"—")+"｜边界："+(x.threshold??"—")+"｜规则："+(x.ruleId||"—")),"","缺陷描述草稿：",r.defectDraft,"","说明："+r.score.note].join("\n");}

document.querySelectorAll(".mode-tab").forEach((b)=>b.addEventListener("click",()=>mode(b.dataset.mode)));
el("sampleSelect").addEventListener("change",sampleNote);el("fileInput").addEventListener("change",(e)=>{state.file=e.target.files[0]||null;el("fileName").textContent=state.file?state.file.name:"选择或拖入单个 .xlsx";});el("analyzeButton").addEventListener("click",analyze);el("searchKnowledge").addEventListener("click",knowledgeSearch);el("knowledgeQuery").addEventListener("keydown",(e)=>{if(e.key==="Enter")knowledgeSearch();});el("copyDraft").addEventListener("click",async()=>{await navigator.clipboard.writeText(el("defectDraft").textContent);toast("缺陷草稿已复制");});el("downloadJson").addEventListener("click",()=>state.result&&download("升压智巡_公开版脱敏报告.json","application/json;charset=utf-8",JSON.stringify(state.result,null,2)));el("downloadText").addEventListener("click",()=>state.result&&download("升压智巡_公开版复核报告.txt","text/plain;charset=utf-8",report(state.result)));

state.engine=await loadEngine();el("ruleVersion").textContent=state.engine.ruleVersion;el("sampleSelect").replaceChildren(...state.engine.samples.map((s)=>{const o=document.createElement("option");o.value=s.id;o.textContent=s.name;return o;}));if(state.engine.samples.some((s)=>s.id==="d12-low-pressure"))el("sampleSelect").value="d12-low-pressure";sampleNote();el("knowledgeQuery").value="GIS断路器压力标准";knowledgeSearch();

