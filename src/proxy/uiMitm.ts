import type { CustomModel } from '../proxy';
import { cleanModelDisplayName } from './modelHealth';

const EFFORT_PARENS_RE = /\s*\((?:low|medium|high|xhigh|minimal|extra)\)\s*$/iu;
const EFFORT_WORDS = new Set(['low', 'medium', 'high', 'xhigh', 'minimal', 'extra', 'default']);

export interface CustomProviderLookupEntry {
  providerName: string;
}

export function inferCustomProviderName(model: Pick<CustomModel, 'name' | 'displayName' | 'provider' | 'providerName'>): string {
  const explicit = (model.providerName || '').trim();
  if (explicit) return explicit;
  const clean = cleanModelDisplayName(model.displayName || model.name);
  const matches = Array.from(clean.matchAll(/\(([^()]+)\)/g));
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i][1].trim();
    if (candidate && !EFFORT_WORDS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return model.provider || 'custom';
}

export function normalizeModelLookupKey(label: string): string {
  return cleanModelDisplayName(label).replace(EFFORT_PARENS_RE, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function buildCustomProviderMap(models: CustomModel[]): Record<string, CustomProviderLookupEntry> {
  const map: Record<string, CustomProviderLookupEntry> = {};
  for (const model of models) {
    if (model.enabled === false) continue;
    const providerName = inferCustomProviderName(model);
    const clean = cleanModelDisplayName(model.displayName || model.name);
    const base = clean.replace(EFFORT_PARENS_RE, '').trim();
    for (const key of [clean, base, model.name]) {
      const normalized = normalizeModelLookupKey(key);
      if (normalized) {
        map[normalized] = { providerName };
      }
    }
  }
  return map;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ExtractedIdentifiers {
  reactVar: string;
  itemComp: string;
  menuItemComp: string;
  groupComp: string;
  subComp: string;
  subTriggerComp: string;
  subContentComp: string;
  separatorComp: string;
  j0cFullMatch: string;
  j0cVar: string;
  contextHook: string;
  scrollHook: string;
  loadingComp: string;
  refreshComp: string;
  customSectionComp: string;
  effortParserFn: string | null;
}

function extractMainJsIdentifiers(source: string): ExtractedIdentifiers | null {
  // Match i0c: var i0c=({group:a})=>D.createElement("div",{className:"flex flex-col gap-px"},a.options.map(b=>D.createElement(h0c,{key:b.label,model:b})));
  const groupMatch = source.match(
    /var ([A-Za-z0-9_$]+)=\(\{group:[A-Za-z0-9_$]+\}\)=>([A-Za-z0-9_$]+)\.createElement\("div",\{className:"flex flex-col gap-px"\},[A-Za-z0-9_$]+\.options\.map\([A-Za-z0-9_$]+=>\2\.createElement\(([A-Za-z0-9_$]+),\{key:[A-Za-z0-9_$]+\.label,model:[A-Za-z0-9_$]+\}\)\)\);/,
  );
  if (!groupMatch) return null;

  const [, groupComp, reactVar, itemComp] = groupMatch;
  const escapedReactVar = escapeRegExp(reactVar);

  // Look back up to 3500 chars before groupComp for GW, HW, yW inside h0c
  const groupIdx = groupMatch.index ?? 0;
  const h0cSlice = source.slice(Math.max(0, groupIdx - 3500), groupIdx);
  const subMatch = h0cSlice.match(
    new RegExp(
      `${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),\\{title:[A-Za-z0-9_$]+\\.base\\},\\s*${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),\\{selected:[A-Za-z0-9_$]+,disabled:[A-Za-z0-9_$]+`,
    ),
  );
  const contentMatch = h0cSlice.match(
    new RegExp(`${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),\\{side:"right",align:"start"`),
  );
  const menuItemMatch = h0cSlice.match(
    new RegExp(`${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),\\{"data-testid":"model-selector-item"`),
  );
  if (!subMatch || !contentMatch || !menuItemMatch) return null;

  const [, subComp, subTriggerComp] = subMatch;
  const [, subContentComp] = contentMatch;
  const [, menuItemComp] = menuItemMatch;

  // Match j0c right after i0c
  const afterGroup = source.slice(groupIdx, Math.min(source.length, groupIdx + 4500));
  const j0cMatch = afterGroup.match(
    new RegExp(
      `var ([A-Za-z0-9_$]+)=\\(\\)=>\\{var \\{groups:([A-Za-z0-9_$]+),refreshModels:([A-Za-z0-9_$]+),customModels:([A-Za-z0-9_$]+),onAddCustomModel:([A-Za-z0-9_$]+),onEditCustomModel:([A-Za-z0-9_$]+),showCustomModelHeader:([A-Za-z0-9_$]+),bestOfNConfig:([A-Za-z0-9_$]+),isModelListLoading:([A-Za-z0-9_$]+)\\}=([A-Za-z0-9_$]+)\\(\\),\\{scrollRef:([A-Za-z0-9_$]+),overflow:([A-Za-z0-9_$]+),onScroll:([A-Za-z0-9_$]+)\\}=([A-Za-z0-9_$]+)\\(\\),[A-Za-z0-9_$]+=\\8\\?\\.isBestOfNEnabled\\?\\?!1;if\\(\\9\\)return ${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),\\{refreshModels:\\3\\}\\);[\\s\\S]*?"No models available"\\),${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),\\{refreshModels:\\3\\}\\)\\)+,\\7&&${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),\\{customModels:\\4,onAddCustomModel:\\5,onEditCustomModel:\\6\\}\\)\\);return ${escapedReactVar}\\.createElement\\("div",\\{className:"relative flex flex-col flex-grow min-h-0"\\}[\\s\\S]*?from-card to-transparent"\\}\\)\\)\\};`,
    ),
  );
  if (!j0cMatch) return null;

  const j0cFullMatch = j0cMatch[0];
  const j0cVar = j0cMatch[1];
  const contextHook = j0cMatch[10];
  const scrollHook = j0cMatch[14];
  const loadingComp = j0cMatch[15];
  const refreshComp = j0cMatch[16];
  const customSectionComp = j0cMatch[17];

  // Match separator DW inside k0c right after j0c
  const k0cSlice = source.slice(groupIdx + (j0cMatch.index ?? 0), Math.min(source.length, groupIdx + (j0cMatch.index ?? 0) + j0cFullMatch.length + 1200));
  const sepMatch = k0cSlice.match(new RegExp(`&&${escapedReactVar}\\.createElement\\(([A-Za-z0-9_$]+),null\\)`));
  const separatorComp = sepMatch ? sepMatch[1] : '';

  // Dynamically extract the effort parser helper (e.g. bW=a=>hSb.get(a.value)??jSb(a.label))
  // so renamed builds never inject a hardcoded undefined identifier.
  const effortParserDefMatch = source.match(
    /(?:^|[,;\n\r\s])(?:(?:var|let|const)\s+)?([A-Za-z0-9_$]+)=([A-Za-z0-9_$]+)=>[A-Za-z0-9_$]+\.get\(\2\.value\)\?\?[A-Za-z0-9_$]+\(\2\.label\)/,
  );
  const effortParserCallMatch = effortParserDefMatch
    ? null
    : source.match(
        /b=\(c=[A-Za-z0-9_$]+\(a,b\)\)\?([A-Za-z0-9_$]+)\(a\):void 0;return c&&b\?\{name:c\.base,effort:b\.effort\}:\{name:a\.label\}\};/,
      );
  const effortParserFn = effortParserDefMatch?.[1] ?? effortParserCallMatch?.[1] ?? null;

  return {
    reactVar,
    itemComp,
    menuItemComp,
    groupComp,
    subComp,
    subTriggerComp,
    subContentComp,
    separatorComp,
    j0cFullMatch,
    j0cVar,
    contextHook,
    scrollHook,
    loadingComp,
    refreshComp,
    customSectionComp,
    effortParserFn,
  };
}

export function patchMainJsModelSelector(
  source: string,
  proxyPort: number,
  initialProviderMap: Record<string, CustomProviderLookupEntry>,
): { code: string; patched: boolean; missed: string[] } {
  const ids = extractMainJsIdentifiers(source);
  if (!ids) {
    return { code: source, patched: false, missed: [] };
  }

  const {
    reactVar: R,
    itemComp: H,
    menuItemComp: ZW,
    groupComp: I,
    subComp: GW,
    subTriggerComp: HW,
    subContentComp: yW,
    separatorComp: DW,
    j0cFullMatch,
    j0cVar: J,
    contextHook: P6,
    scrollHook: TA,
    loadingComp: G0,
    refreshComp: F0,
    customSectionComp: E0,
    effortParserFn,
  } = ids;

  const initJson = JSON.stringify(initialProviderMap);
  const dividerExpr = DW ? `${R}.createElement(${DW},{key:"__agy_div__"})` : `${R}.createElement("div",{key:"__agy_div__",className:"my-1 h-px bg-border"})`;

  const replacement = `var ${J}=()=>{if(typeof document!=="undefined"&&document.documentElement)document.documentElement.dataset.agyMitmSelector="1";var {groups:a,refreshModels:b,customModels:c,onAddCustomModel:d,onEditCustomModel:f,showCustomModelHeader:g,bestOfNConfig:h,isModelListLoading:k,selectedModel:sm,setSelectedModel:ssm}=${P6}(),{scrollRef:l,overflow:m,onScroll:n}=${TA}(),[sq,setSq]=${R}.useState(""),[pm,setPm]=${R}.useState(()=>(window.__AGY_PROVIDERS_INIT__||(window.__AGY_PROVIDERS_INIT__=${initJson})));var syncProviders=force=>{fetch("http://127.0.0.1:${proxyPort}/_ui/custom-providers.json").then(r=>r.ok?r.json():null).then(j=>{if(j&&typeof j==="object"){var changed=JSON.stringify(window.__AGY_PROVIDERS_INIT__||{})!==JSON.stringify(j);window.__AGY_PROVIDERS_INIT__=j;if(changed)setPm(j);if((changed||force)&&typeof b==="function"){var now=Date.now();if(force||now-(window.__AGY_LAST_REFETCH__||0)>3000){window.__AGY_LAST_REFETCH__=now;b();}}}}).catch(()=>{});};${R}.useEffect(()=>{if(typeof document!=="undefined"&&document.documentElement)document.documentElement.dataset.agyMitmSelector="1";syncProviders(!1);},[]);var effRe=/\\s*\\((low|medium|high|xhigh|minimal|extra)\\)\\s*$/iu;var effOrder={minimal:0,low:1,medium:2,high:3,xhigh:4,extra:5};var effCap=e=>e.toLowerCase()==="xhigh"?"XHigh":e.charAt(0).toUpperCase()+e.slice(1).toLowerCase();var norm=s=>String(s||"").replace(/^[\\u2B50\\s]+/u,"").replace(/^[\\u{1F7E2}\\u{1F534}\\u26AA\\u{1F7E1}\\u2B50\\s•·|-]+(?:\\[[^\\]]+\\]\\s*)?[•·|-]?\\s*/u,"").replace(effRe,"").replace(/\\s+/g," ").trim().toLowerCase();var renderProviderItems=opts=>{var byBase=new Map();for(var opt of opts){var raw=String(opt.label||"");var em=raw.match(effRe);var base=em?raw.slice(0,em.index).trim():raw;var arr=byBase.get(base)||[];arr.push({opt:opt,eff:em?effCap(em[1]):null,ord:em?(effOrder[em[1].toLowerCase()]??9):9});byBase.set(base,arr);}var out=[];for(let [base,vars] of byBase.entries()){if(vars.length>=2&&vars.every(v=>v.eff)){vars.sort((x,y)=>x.ord-y.ord);let selV=sm?vars.find(v=>v.opt.label===sm.label):null;let defV=selV||vars.find(v=>v.eff==="Medium")||vars[0];out.push(${R}.createElement(${GW},{key:"eg_"+base,title:base},${R}.createElement(${HW},{selected:!!selV,disabled:!!defV.opt.disabled,onDesktopClick:()=>{ssm&&ssm({...defV.opt,isCustom:!0});}},${R}.createElement("span",{"data-testid":"model-selector-effort-group","data-model-base":base,className:"truncate text-sm text-left"},base),${R}.createElement("span",{className:"shrink-0 opacity-70 text-sm"},defV.eff)),${R}.createElement(${yW},{side:"right",align:"start",collisionBoundary:"viewport",className:"min-w-40"},${R}.createElement("div",{className:"flex flex-col gap-px"},vars.map(v=>${R}.createElement(${ZW},{key:"eff_"+v.opt.label,selected:!!(sm&&sm.label===v.opt.label),disabled:!!v.opt.disabled,onClick:()=>{ssm&&ssm({...v.opt,isCustom:!0});}},${R}.createElement("span",{"data-testid":"model-selector-effort-option",className:"truncate"},v.eff)))))));}else{for(let v of vars){out.push(${R}.createElement(${H},{key:"m_"+v.opt.label,model:{...v.opt,isCustom:!0}}));}}}return out;};var p=h?.isBestOfNEnabled??!1;if(k)return ${R}.createElement(${G0},{refreshModels:b});var q=a.some(t=>t.options.length>0);var ql=sq.trim().toLowerCase();var off=[];var pmap=new Map();for(var grp of a){for(var opt of grp.options){var lbl=norm(opt.label);var hit=pm[lbl];if(hit&&hit.providerName){var arr=pmap.get(hit.providerName)||[];arr.push(opt);pmap.set(hit.providerName,arr);}else{off.push({groupName:grp.groupName,opt:opt});}}}var bodyNodes=[];if(ql){var allMatches=[];for(var item of off){if(String(item.opt.label||"").toLowerCase().includes(ql))allMatches.push(item.opt);}for(var [pn,opts] of pmap.entries()){for(var opt of opts){if((String(opt.label||"")+" "+pn).toLowerCase().includes(ql))allMatches.push(opt);}}bodyNodes=allMatches.length?allMatches.map(opt=>${R}.createElement(${H},{key:"s_"+opt.label,model:{...opt,isCustom:!0}})):[${R}.createElement("div",{key:"__agy_empty__",className:"text-xs opacity-60 px-2 py-3 text-center"},"No matching models")];}else if(q){var offByGrp=new Map();for(var item of off){var arr=offByGrp.get(item.groupName)||[];arr.push(item.opt);offByGrp.set(item.groupName,arr);}for(var [gn,opts] of offByGrp.entries()){if(opts.length)bodyNodes.push(${R}.createElement(${I},{key:"off_"+gn,group:{groupName:gn,options:opts}}));}if(pmap.size>0){bodyNodes.push(${dividerExpr});for(var [pn,opts] of pmap.entries()){var act=sm&&opts.some(o=>o.label===sm.label||norm(o.label)===norm(sm.label));bodyNodes.push(${R}.createElement(${GW},{key:"prov_"+pn,title:pn},${R}.createElement(${HW},{selected:!!act,disabled:!1},${R}.createElement("span",{className:"truncate text-sm text-left flex-1"},pn)),${R}.createElement(${yW},{side:"right",align:"start",collisionBoundary:"viewport",className:"min-w-56"},${R}.createElement("div",{className:"flex flex-col gap-px max-h-80 overflow-y-auto"},renderProviderItems(opts)))));}}}else{bodyNodes=[${R}.createElement("div",{key:"__empty__","data-testid":"model-selector-empty",className:"flex flex-col items-center gap-3 px-2 py-4"},${R}.createElement("span",{className:"text-sm opacity-50"},"No models available"),${R}.createElement(${F0},{refreshModels:b}))];}var pEl=${R}.createElement(${R}.Fragment,null,${R}.createElement("div",{"data-testid":"model-selector-header",className:"text-sm px-2 pb-1 text-muted-foreground font-medium flex items-center justify-between"},${R}.createElement("span",null,p?"Best of N Models":"Model"),${R}.createElement("button",{type:"button",title:"Refresh models","aria-label":"Refresh models",className:"rounded p-0.5 text-muted-foreground hover:text-foreground",onClick:e=>{e.stopPropagation();syncProviders(!0);}},"↻")),${R}.createElement("div",{className:"px-1.5 pb-1.5"},${R}.createElement("div",{className:"relative flex items-center"},${R}.createElement("svg",{viewBox:"0 0 16 16",fill:"none","aria-hidden":"true",className:"pointer-events-none absolute left-3 h-3.5 w-3.5 text-muted-foreground"},${R}.createElement("path",{d:"M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3.2-3.2",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})),${R}.createElement("input",{type:"search",value:sq,placeholder:"Search models...",autoFocus:!0,"aria-label":"Search models",className:"w-full rounded-md border border-border bg-background/60 py-1.5 pl-8 pr-6 text-xs outline-none focus:border-ring",onChange:e=>setSq(e.target.value),onKeyDown:e=>{if(e.key==="Escape"&&sq){e.preventDefault();e.stopPropagation();setSq("");}else if(e.key!=="Escape"&&e.key!=="Tab"){e.stopPropagation();}}}),sq&&${R}.createElement("button",{type:"button","aria-label":"Clear search",className:"absolute right-1.5 rounded px-1 text-xs text-muted-foreground hover:text-foreground",onClick:e=>{e.stopPropagation();setSq("");}},"✕"))),bodyNodes,g&&${R}.createElement(${E0},{customModels:c,onAddCustomModel:d,onEditCustomModel:f}));return ${R}.createElement("div",{className:"relative flex flex-col flex-grow min-h-0",ref:el=>{if(!el||!el.dataset)return;try{var uuidRe=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;var fk=Object.keys(el).find(k=>k.startsWith("__reactFiber")||k.startsWith("__reactInternalInstance"));var fiber=fk?el[fk]:null;for(var d=0;fiber&&d<80;d++,fiber=fiber.return){var pr=fiber.memoizedProps;if(!pr||typeof pr!=="object")continue;for(var v of [pr.conversationId,pr.cascadeId,pr.activeConversationId,pr.currentConversationId,pr.conversation&&pr.conversation.id,pr.cascade&&pr.cascade.id]){if(typeof v==="string"&&uuidRe.test(v)){el.dataset.agyConversationId=v;if(document.querySelectorAll("[data-agy-conversation-id]").length<=1)document.documentElement.dataset.agyConversationId=v;return;}}}}catch(_){}}},${R}.createElement("div",{ref:l,onScroll:n,className:"flex flex-col flex-grow min-h-0 pt-0 overflow-y-auto overscroll-y-none pb-1 gap-px scrollbar-none"},pEl),m.top&&${R}.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-b pointer-events-none absolute top-0 left-0 right-0 h-6 from-card to-transparent"}),m.bottom&&${R}.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-t pointer-events-none absolute bottom-0 left-0 right-0 h-6 from-card to-transparent"}))};`;

  // Use function replacer so special `$&`, `$'`, `` $` ``, `$$` sequences inside
  // user-supplied model/provider names never expand and corrupt `/main.js`.
  let code = source.replace(j0cFullMatch, () => replacement);
  // Ensure h0c's nested effort submenu also uses collisionBoundary:"viewport" so it opens to the right of the provider submenu instead of flipping left into the main menu
  const effortSubPattern = `${R}.createElement(${yW},{side:"right",align:"start",className:"min-w-40"}`;
  const effortSubReplacement = `${R}.createElement(${yW},{side:"right",align:"start",collisionBoundary:"viewport",className:"min-w-40"}`;
  if (code.includes(effortSubPattern)) {
    code = code.replace(effortSubPattern, () => effortSubReplacement);
  }
  /**
   * Effort tables the native picker holds only for its own models. Without them the effort of a
   * custom model stays inside the model name ("Model (High)") instead of rendering as the dimmed
   * effort suffix official models use. A renamed build is reported instead of silently unpatched.
   */
  const effortPatches: [name: string, find: string, replace: string][] = [
    ['effort order', '["low","medium","high","xhigh","max"]', '["minimal","low","medium","high","xhigh","extra","max"]'],
    ['effort labels', 'aW={low:"Low",', 'aW={minimal:"Minimal",extra:"Extra",low:"Low",'],
    [
      'label effort pattern',
      'iSb=/^(.*?)\\s*\\((low|medium|high|xhigh|max)(?:\\s+thinking)?\\)\\s*$/i',
      'iSb=/^(.*?)\\s*\\((minimal|low|medium|high|xhigh|extra|max)(?:\\s+thinking)?\\)\\s*$/i',
    ],
    ['modelId effort pattern', 'lW=/-(low|medium|high|xhigh|max)$/', 'lW=/-(minimal|low|medium|high|xhigh|extra|max)$/'],
  ];
  const geminiFilter = 'a?a.toLowerCase().includes("gemini"):!1';
  if (code.includes(geminiFilter)) {
    code = code.replace(geminiFilter, '!0');
  }
  const missed: string[] = [];
  if (effortParserFn) {
    effortPatches.push(
      [
        'effort fallback',
        'byEffort.size>=2?{name:c.displayName,effort:b.effort}:{name:a.label};',
        `byEffort.size>=2?{name:c.displayName,effort:b.effort}:(b=${effortParserFn}(a))?{name:b.base,effort:b.effort}:{name:a.label};`,
      ],
      [
        'effort fallback (ungrouped)',
        'return c&&b?{name:c.base,effort:b.effort}:{name:a.label}};',
        `return c&&b?{name:c.base,effort:b.effort}:(b=${effortParserFn}(a))?{name:b.base,effort:b.effort}:{name:a.label}};`,
      ],
    );
  }
  for (const [name, find, replace] of effortPatches) {
    if (!code.includes(find)) {
      missed.push(name);
      continue;
    }
    code = code.split(find).join(replace);
  }
  if (!effortParserFn) {
    missed.push('effort fallback', 'effort fallback (ungrouped)');
  }
  return { code, patched: code !== source, missed };
}
