const META = new Set([
  "记录编号","填表时间","表单名称","表单编号","二维码名称","二维码地址","巡检人","填表人","姓名",
  "手机号","手机号归属地","身份证","工号","地址","经度","纬度","图片链接","签名链接","PDF链接",
  "记录结果","审核时间","审核人","审核结果","审核备注","提交后编号","处理进度","处理人","处理时间",
  "后续动态","来源","主记录编号","填写方式"
]);
const PII = new Set(["巡检人","填表人","姓名","手机号","手机号归属地","身份证","工号","地址","经度","纬度","二维码地址","图片链接","签名链接","PDF链接"]);
const DESCRIPTION = /(描述|备注|说明|后续动态)/;
const ABNORMAL = /(异常|否|×|不正常|告警|报警|故障)/i;
const NORMAL = /^(√|正常|是|无|完好|合格)$/i;
const RANK = {"正常":0,"规则不足":1,"需复核":2,"异常":3};

const clean=(v)=>v==null?null:(typeof v==="string"?(v.trim()===""?null:v.trim()):v);
const number=(v)=>{
  if(typeof v==="number"&&Number.isFinite(v)) return v;
  if(typeof v!=="string") return null;
  const m=v.replaceAll(",","").match(/-?\d+(?:\.\d+)?/);
  return m?Number(m[0]):null;
};
const unique=(xs)=>[...new Set(xs.filter(Boolean))];
const inspection=(h)=>h&&!META.has(h)&&!PII.has(h)&&!DESCRIPTION.test(h);
const objectRow=(headers,row)=>Object.fromEntries(headers.map((h,i)=>[h,clean(row[i])]));

function redactText(value){
  if(value==null) return value;
  return String(value)
    .replace(/[一-龥]{2,12}风电场/g,"某风电场")
    .replace(/[一-龥]{2,12}新能源(?:（[^）]+）)?有限公司/g,"某新能源企业")
    .replace(/(?<!\d)1\d{10}(?!\d)/g,"[手机号已脱敏]")
    .replace(/https?:\/\/[^\s]+/gi,"[链接已脱敏]");
}
function redactRows(headers,rows){
  return rows.map((row)=>row.map((v,i)=>{
    const h=headers[i]||"";
    if(PII.has(h)) return v==null||v===""?v:"[已脱敏]";
    if(h==="记录编号") return v==null||v===""?v:"[记录编号已脱敏]";
    return typeof v==="string"?redactText(v):v;
  }));
}
function inferForm(headers,rows,fileName=""){
  const i=headers.indexOf("表单编号");
  const cell=i>=0?rows.map((r)=>r[i]).find(Boolean):null;
  if(cell&&/^D\d+$/i.test(String(cell).trim())) return String(cell).trim().toUpperCase();
  const m=[fileName,...headers].join(" ").match(/(?:^|[^A-Z0-9])(D\d{1,3})(?:[^A-Z0-9]|$)/i);
  return m?m[1].toUpperCase():null;
}
function add(checks,c){
  checks.push({
    id:c.id,category:c.category,status:c.status,title:c.title,detail:c.detail,
    observed:c.observed??null,threshold:c.threshold??null,unit:c.unit??null,
    ruleId:c.ruleId??null,confidence:c.confidence??"高"
  });
}
function structural(headers,records,checks){
  const fields=headers.filter(inspection);
  records.forEach((r,i)=>{
    const missing=fields.filter((h)=>r[h]===null);
    if(missing.length) add(checks,{id:"STRUCT-MISSING-"+(i+1),category:"完整性",status:"需复核",title:"第"+(i+1)+"条记录存在漏项",detail:missing.slice(0,8).join("、")+(missing.length>8?"等"+missing.length+"项":""),observed:missing.length,threshold:0,unit:"项",ruleId:"STRUCT-REQUIRED"});
    const bad=fields.filter((h)=>typeof r[h]==="string"&&ABNORMAL.test(r[h])&&!NORMAL.test(r[h]));
    const desc=headers.filter((h)=>DESCRIPTION.test(h)).some((h)=>r[h]);
    if(bad.length&&!desc) add(checks,{id:"STRUCT-NO-DESC-"+(i+1),category:"闭环完整性",status:"需复核",title:"异常勾选缺少描述",detail:"异常字段："+bad.slice(0,5).join("、"),observed:"异常项无描述",threshold:"应填写现象、位置、时间与影响",ruleId:"STRUCT-ABNORMAL-DESCRIPTION"});
    if(r["处理进度"]&&(!r["处理人"]||!r["处理时间"])) add(checks,{id:"STRUCT-CLOSURE-"+(i+1),category:"闭环完整性",status:"需复核",title:"处理状态缺少责任人或时间",detail:"已填写处理进度，但闭环责任字段不完整。",ruleId:"STRUCT-CLOSURE"});
  });
  const ids=records.map((r)=>r.__sourceId).filter(Boolean);
  const dup=unique(ids.filter((id,i)=>ids.indexOf(id)!==i));
  if(dup.length) add(checks,{id:"STRUCT-DUPLICATE",category:"重复记录",status:"需复核",title:"发现重复记录编号",detail:"重复编号已脱敏展示",observed:dup.length,threshold:0,unit:"个",ruleId:"STRUCT-DUPLICATE"});
  const times=records.map((r)=>Date.parse(r["填表时间"])).filter(Number.isFinite);
  if(times.some((v,i)=>i>0&&v<times[i-1])) add(checks,{id:"STRUCT-TIME-ORDER",category:"时间顺序",status:"需复核",title:"记录时间存在倒序",detail:"请核实导出顺序或填表时间。",ruleId:"STRUCT-TIME-ORDER"});
}
function d12(headers,records,checks){
  const fields=headers.filter((h)=>/MPa/i.test(h)&&/(SF6气体压力|气室)/.test(h)&&!/(每日定时记录|不低于|≥)/.test(h));
  fields.forEach((h)=>{
    const breaker=/断路器/.test(h),limit=breaker?0.6:0.4,ruleId=breaker?"D12-SF6-BREAKER-MIN":"D12-SF6-OTHER-MIN";
    records.forEach((r,i)=>{
      const observed=number(r[h]);
      if(observed===null) return add(checks,{id:ruleId+"-TYPE-"+i,category:"数据类型",status:"需复核",title:h+"不是有效数值",detail:"无法执行确定性压力阈值判断。",observed:r[h],threshold:limit,unit:"MPa",ruleId});
      const ok=observed>=limit;
      add(checks,{id:ruleId+"-"+i+"-"+h,category:"阈值判断",status:ok?"正常":"异常",title:h+(ok?"达到阈值":"低于阈值"),detail:ok?"临界值按≥通过。":"复核仪表、温度、单位和工况，再按现场规程报告。",observed,threshold:"≥"+limit,unit:"MPa",ruleId});
    });
  });
  if(!fields.length) add(checks,{id:"D12-NO-PRESSURE",category:"字段识别",status:"需复核",title:"未识别到GIS压力字段",detail:"请核实是否为标准D12导出格式。",ruleId:"D12-SF6-BREAKER-MIN"});
}
function d13(headers,records,checks){
  headers.filter((h)=>/(油面温度|绕组温度)/.test(h)).forEach((h)=>{
    const oil=/油面温度/.test(h);
    records.forEach((r,i)=>{
      const observed=number(r[h]); if(observed===null) return;
      let status="正常",title=h+"低于日常关注线",ruleId="D13-TEMP-ATTENTION",threshold="<85℃";
      if(oil&&observed>105) [status,title,ruleId,threshold]=["异常",h+"超过跳闸线","D13-OIL-TRIP",">105℃"];
      else if(oil&&observed>95) [status,title,ruleId,threshold]=["异常",h+"超过报警线","D13-OIL-ALARM",">95℃"];
      else if(!oil&&observed>120) [status,title,ruleId,threshold]=["异常",h+"超过跳闸线","D13-WINDING-TRIP",">120℃"];
      else if(!oil&&observed>105) [status,title,ruleId,threshold]=["异常",h+"超过报警线","D13-WINDING-ALARM",">105℃"];
      else if(observed>=85) [status,title,ruleId,threshold]=["需复核",h+"达到日常点检关注线","D13-TEMP-ATTENTION","≥85℃"];
      add(checks,{id:ruleId+"-"+i+"-"+h,category:"分层阈值",status,title,detail:status==="正常"?"日常关注线与报警、跳闸线分层判断。":"复核负荷、环境温度、测控显示，并按规程处置。",observed,threshold,unit:"℃",ruleId});
    });
  });
}
function d10(headers,records,checks){
  if(records.length<2) return;
  headers.filter((h)=>/压力.*MPa/i.test(h)).forEach((h)=>{
    const first=number(records[0][h]),last=number(records.at(-1)[h]);
    if(first===null||last===null||first===0) return;
    if(Math.abs(last-first)/Math.abs(first)>=0.5) add(checks,{id:"D10-PRESSURE-TREND-"+h,category:"跨轮次趋势",status:"需复核",title:h+"同日变化显著",detail:"只要求复核运行状态、量程、单位和启停工况，不据此判定故障。",observed:first+" → "+last,threshold:"相对变化≥50%",unit:"MPa",ruleId:"D10-PRESSURE-TREND",confidence:"中"});
  });
}
function d26(headers,records,checks){
  headers.filter((h)=>/(温度|湿度|适度)/.test(h)).forEach((h)=>records.forEach((r,i)=>{
    if(r[h]!==null&&number(r[h])===null) add(checks,{id:"D26-STRUCTURE-"+i+"-"+h,category:"数据类型",status:"需复核",title:h+"不是有效数值",detail:"当前规则只验证数值有效性，不套用其他设备温湿度边界。",observed:r[h],ruleId:"D26-STRUCTURE"});
  }));
}
function score(checks,formNo,citations){
  const count=(predicate)=>checks.filter(predicate).length;
  const missing=count((c)=>c.category==="完整性");
  const quality=count((c)=>["数据类型","重复记录","时间顺序"].includes(c.category));
  const abnormal=count((c)=>c.status==="异常");
  const review=count((c)=>c.status==="需复核"&&["阈值判断","分层阈值","跨轮次趋势"].includes(c.category));
  const insufficient=count((c)=>c.status==="规则不足");
  const closure=count((c)=>c.category==="闭环完整性");
  const dimensions={
    completeness:Math.max(0,30-missing*6-quality*4),
    compliance:Math.max(0,40-abnormal*20-review*12-insufficient*10),
    closure:Math.max(0,20-closure*10),
    traceability:citations.length?10:(formNo?6:2)
  };
  const total=Object.values(dimensions).reduce((a,b)=>a+b,0);
  const grade=total>=92?"A":total>=80?"B":total>=65?"C":"D";
  const level=total>=92?"优秀":total>=80?"良好":total>=65?"需改进":"高风险";
  return {total,grade,level,dimensions,maxima:{completeness:30,compliance:40,closure:20,traceability:10},note:"评分衡量记录质量、规则符合度与闭环完整性，不代表设备健康度或EHS等级。"};
}
function buildKnowledge(ruleData){
  return ruleData.rules.map((r)=>{
    const source=ruleData.sources.find((s)=>s.id===r.sourceId);
    return {
      id:r.ruleId,formNo:r.formNo,title:r.equipmentType+"｜"+r.ruleId,
      text:[r.formNo,r.equipmentType,r.fieldPattern,r.operator,r.threshold,r.unit,r.requiredAction,source?.label,source?.locator].join(" "),
      snippet:(r.operator==="relative-change"?"相对变化阈值 "+Math.round(r.threshold*100)+"%":r.threshold==null?"执行字段和类型校验":r.operator+" "+r.threshold+" "+r.unit)+"；"+r.requiredAction,
      sourceLabel:source?.label||r.sourceId,sourceLocator:source?.locator||""
    };
  });
}
function retrieve(documents,query,limit=6){
  const q=String(query||"").trim().toLowerCase();
  if(!q) return [];
  const chunks=q.split(/[\s，。；、｜/]+/).filter((x)=>x.length>1);
  const chinese=(q.match(/[一-龥]+/g)||[]);
  const bigrams=chinese.flatMap((part)=>Array.from({length:Math.max(0,part.length-1)},(_,i)=>part.slice(i,i+2)));
  const terms=unique([q,...chunks,...bigrams]);
  return documents.map((d)=>{
    const hay=(d.title+" "+d.text).toLowerCase();
    let relevance=0;
    terms.forEach((t)=>{if(hay.includes(t)) relevance+=t===q?8:3;});
    if(q.includes(String(d.formNo).toLowerCase())) relevance+=5;
    if(q.includes(String(d.id).toLowerCase())) relevance+=8;
    return {...d,relevance};
  }).filter((d)=>d.relevance>0).sort((a,b)=>b.relevance-a.relevance).slice(0,limit);
}

export function createEngine({ruleData,sampleData,schemaData}){
  const schemas=new Map(schemaData.forms.map((f)=>[f.formNo,f]));
  const documents=buildKnowledge(ruleData);
  function searchKnowledge(query,limit){return retrieve(documents,query,limit);}
  function analyze(input,{source="upload",ehsLevel=null}={}){
    const headers=input.headers.map((h)=>String(h??"").trim());
    const sourceIdIndex=headers.indexOf("记录编号");
    const safeRows=redactRows(headers,input.rows);
    const records=safeRows.map((row,i)=>({...objectRow(headers,row),__sourceId:sourceIdIndex>=0?clean(input.rows[i]?.[sourceIdIndex]):null}));
    const formNo=inferForm(headers,safeRows,input.fileName);
    const schema=schemas.get(formNo);
    const checks=[];
    structural(headers,records,checks);
    if(formNo==="D12") d12(headers,records,checks);
    else if(formNo==="D13") d13(headers,records,checks);
    else if(formNo==="D10") d10(headers,records,checks);
    else if(formNo==="D26") d26(headers,records,checks);
    else add(checks,{id:"RULE-COVERAGE",category:"规则覆盖",status:"规则不足",title:formNo?formNo+"暂未配置设备绝对阈值":"无法识别表单编号",detail:"已执行结构、类型、时间、重复和闭环检查；不制造设备故障结论。",ruleId:"RULE-COVERAGE"});
    if(!checks.length) add(checks,{id:"STRUCT-PASS",category:"结构质检",status:schema?"正常":"规则不足",title:schema?"未发现结构性问题":"表单结构未纳入首版清单",detail:schema?"已完成可执行规则检查。":"仅完成通用解析。",ruleId:schema?"STRUCT-PASS":"RULE-COVERAGE"});
    const status=checks.reduce((s,c)=>RANK[c.status]>RANK[s]?c.status:s,"正常");
    const citations=unique(checks.map((c)=>c.ruleId)).map((id)=>ruleData.rules.find((r)=>r.ruleId===id)).filter(Boolean).map((r)=>{
      const src=ruleData.sources.find((s)=>s.id===r.sourceId);
      return {ruleId:r.ruleId,sourceLabel:src?.label||r.sourceId,sourceLocator:src?.locator||"",requiredAction:r.requiredAction};
    });
    const issues=checks.filter((c)=>c.status!=="正常");
    const questions=unique(issues.slice(0,5).map((c)=>c.category==="跨轮次趋势"?"两轮记录期间设备运行、启停或测量量程是否发生变化？":c.category==="完整性"?"缺失项是漏填、不可测，还是设备不适用？":["阈值判断","分层阈值"].includes(c.category)?"现场表计、后台测控与原始记录是否一致？":"请确认“"+c.title+"”的现场事实与责任人。"));
    const defectDraft=issues.length?"某风电场升压站"+(formNo||"未知表单")+"复核发现："+issues.slice(0,3).map((c)=>c.title+"（观测值："+(c.observed??"未记录")+"）").join("；")+"。建议先核实原始表计、单位、工况和记录完整性，再由值班负责人确认处理级别。":"本次自动复核未发现已配置规则范围内的问题；仍需现场人员确认巡检事实。";
    const related=retrieve(documents,[formNo,...checks.map((c)=>c.ruleId),...headers.slice(0,12)].join(" "),6);
    const ehs=ruleData.ehs[ehsLevel];
    return {
      status,
      summary:{formNo,formName:records[0]?.["表单名称"]||schema?.name||"未识别",recordCount:records.length,fieldCount:headers.filter(inspection).length,normalCount:checks.filter((c)=>c.status==="正常").length,reviewCount:checks.filter((c)=>c.status==="需复核").length,abnormalCount:checks.filter((c)=>c.status==="异常").length,insufficientCount:checks.filter((c)=>c.status==="规则不足").length,ruleVersion:ruleData.version,source},
      checks,clarifyingQuestions:questions,defectDraft,
      closureChecklist:["复核现场表计、后台测控、单位与运行工况","补充现象、位置、时间、影响范围和原始观测值","由值班负责人确认结论与处置级别","记录处理人、处理时间、结果和后续动态"],
      ehsEscalation:ehs?{selectedLevel:ehsLevel,message:"该提醒仅基于用户选择的事件等级，不代表系统自动认定。",steps:ehs.steps,sourceId:ehs.sourceId}:{selectedLevel:null,message:"系统不自动认定事故事件等级。仅在人员确认等级后显示对应时限提醒。",availableLevels:Object.keys(ruleData.ehs)},
      citations,knowledgeHits:related,score:score(checks,formNo,citations),
      confidence:status==="需复核"&&checks.some((c)=>c.confidence==="中")?"中":"高",
      modelEnhanced:false,modelNote:"公开无密钥版：知识检索、规则校验与评分均在浏览器本地执行。",
      sanitizedInput:{headers,rows:safeRows}
    };
  }
  return {samples:sampleData.samples,analyze,searchKnowledge,ruleVersion:ruleData.version,documents};
}
export async function loadEngine(){
  const base=document.baseURI;
  const [ruleData,sampleData,schemaData]=await Promise.all(["data/rules.json","data/samples.json","data/form-schemas.json"].map(async (path)=>{
    const response=await fetch(new URL(path,base),{cache:"no-store"});
    if(!response.ok) throw new Error("知识库加载失败："+path);
    return response.json();
  }));
  return createEngine({ruleData,sampleData,schemaData});
}

