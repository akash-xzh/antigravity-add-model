import { describe, expect, it } from 'vitest';
import { buildCustomProviderMap, patchMainJsModelSelector } from '../proxy/uiMitm';
import type { CustomModel } from '../proxy';

describe('UI MITM Model Selector Patcher', () => {
  it('builds normalized provider map with explicit providerName and suffix fallback', () => {
    const models = [
      {
        name: 'models/nim-1',
        displayName: '🟢 • nvidia/nemotron-3-ultra',
        provider: 'openai',
        providerName: 'NVIDIA NIM',
        apiUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: 'x',
        externalModelName: 'nvidia/nemotron-3-ultra',
        enabled: true,
      },
      {
        name: 'models/agnes-low',
        displayName: 'Agnes 2 5 Flash (Agnes AI) (low)',
        provider: 'openai',
        apiUrl: 'https://agnes.example/v1',
        apiKey: 'x',
        externalModelName: 'agnes-2.5-flash',
        enabled: true,
      },
      {
        name: 'models/disabled',
        displayName: 'Hidden Model',
        provider: 'openai',
        providerName: 'DisabledGroup',
        apiUrl: 'https://disabled.example/v1',
        apiKey: 'x',
        externalModelName: 'hidden',
        enabled: false,
      },
    ] as CustomModel[];

    const map = buildCustomProviderMap(models);
    expect(map['nvidia/nemotron-3-ultra']).toEqual({ providerName: 'NVIDIA NIM' });
    expect(map['agnes 2 5 flash (agnes ai)']).toEqual({ providerName: 'Agnes AI' });
    expect(map['hidden model']).toBeUndefined();
  });

  it('patches Antigravity /main.js model selector component with valid JavaScript syntax', () => {
    const sampleMainJs = `
      var h0c=({model:a})=>{return D.createElement(GW,{title:y.base},D.createElement(HW,{selected:A,disabled:v,onDesktopClick:()=>{}},D.createElement("span",{"data-testid":"model-selector-effort-group","data-model-base":y.base},y.base)),D.createElement(yW,{side:"right",align:"start",className:"min-w-40"},null));return D.createElement(zW,{"data-testid":"model-selector-item","data-model-label":a.label,selected:t,disabled:v,onClick:()=>{}},null);};
      var i0c=({group:a})=>D.createElement("div",{className:"flex flex-col gap-px"},a.options.map(b=>D.createElement(h0c,{key:b.label,model:b})));
      var j0c=()=>{var {groups:a,refreshModels:b,customModels:c,onAddCustomModel:d,onEditCustomModel:f,showCustomModelHeader:g,bestOfNConfig:h,isModelListLoading:k}=p6(),{scrollRef:l,overflow:m,onScroll:n}=tA(),p=h?.isBestOfNEnabled??!1;if(k)return D.createElement(g0c,{refreshModels:b});var q=a.some(t=>t.options.length>0);p=D.createElement(D.Fragment,null,D.createElement("div",{"data-testid":"model-selector-header",className:"text-sm px-2 pb-1 text-muted-foreground font-medium"},p?"Best of N Models":"Model"),q?a.map(t=>t.options.length>0&&D.createElement(i0c,{key:t.groupName,group:t})):D.createElement("div",{"data-testid":"model-selector-empty",className:"flex flex-col items-center gap-3 px-2 py-4"},D.createElement("span",{className:"text-sm opacity-50"},"No models available"),D.createElement(f0c,{refreshModels:b})),g&&D.createElement(e0c,{customModels:c,onAddCustomModel:d,onEditCustomModel:f}));return D.createElement("div",{className:"relative flex flex-col flex-grow min-h-0"},D.createElement("div",{ref:l,onScroll:n,className:"flex flex-col flex-grow min-h-0 pt-0 overflow-y-auto overscroll-y-none pb-1 gap-px scrollbar-none"},p),m.top&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-b pointer-events-none absolute top-0 left-0 right-0 h-6 from-card to-transparent"}),m.bottom&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-t pointer-events-none absolute bottom-0 left-0 right-0 h-6 from-card to-transparent"}))};
      var k0c=({extra:a}={})=>{return D.createElement(D.Fragment,null,(d||a)&&D.createElement(DW,null));};
      const gSb=["low","medium","high","xhigh","max"],aW={low:"Low",medium:"Medium",high:"High",xhigh:"Extra",max:"Max"},hSb=new Map,iSb=/^(.*?)\\s*\\((low|medium|high|xhigh|max)(?:\\s+thinking)?\\)\\s*$/i;
      var jSb=a=>{if(a=iSb.exec(a))return{base:a[1].trim(),effort:a[2].toLowerCase()}},bW=a=>hSb.get(a.value)??jSb(a.label);
      const lW=/-(low|medium|high|xhigh|max)$/;
      var nSb=(a,b)=>{var c=cW.get(b);if(c)return c=(b=fW(c,a))?c.groupsByKey.get(b.groupKey):void 0,b&&c&&c.byEffort.size>=2?{name:c.displayName,effort:b.effort}:{name:a.label};b=(c=hW(a,b))?bW(a):void 0;return c&&b?{name:c.base,effort:b.effort}:{name:a.label}};
    `;

    const result = patchMainJsModelSelector(sampleMainJs, 50999, {
      'nvidia/nemotron-3-ultra': { providerName: 'NVIDIA NIM' },
    });

    expect(result.patched).toBe(true);
    expect(result.code).toContain('document.documentElement.dataset.agyMitmSelector="1"');
    expect(result.code).toContain('data-agy-conversation-id');
    expect(result.code).toContain('__reactFiber');
    expect(result.code).toContain('http://127.0.0.1:50999/_ui/custom-providers.json');
    expect(result.code).toContain('D.createElement(GW,{key:"prov_"+pn,title:pn}');
    expect(result.code).toContain('D.createElement(DW,{key:"__agy_div__"})');
    // A custom model's effort must reach the trigger as its own dimmed suffix, not as part of the name.
    expect(result.missed).toEqual([]);
    expect(result.code).toContain('iSb=/^(.*?)\\s*\\((minimal|low|medium|high|xhigh|extra|max)(?:\\s+thinking)?\\)\\s*$/i');
    expect(result.code).toContain('aW={minimal:"Minimal",extra:"Extra",low:"Low",');
    expect(result.code).toContain('["minimal","low","medium","high","xhigh","extra","max"]');
    expect(result.code).toContain('lW=/-(minimal|low|medium|high|xhigh|extra|max)$/');
    expect(result.code).toContain('byEffort.size>=2?{name:c.displayName,effort:b.effort}:(b=bW(a))?{name:b.base,effort:b.effort}:{name:a.label};');
    expect(result.code).toContain('return c&&b?{name:c.base,effort:b.effort}:(b=bW(a))?{name:b.base,effort:b.effort}:{name:a.label}};');
    // Verify generated JS parses without SyntaxError
    expect(() => new Function(result.code)).not.toThrow();
  });

  it('reports effort tables it could not patch instead of silently leaving them', () => {
    const sampleMainJs = `
      var h0c=({model:a})=>{return D.createElement(GW,{title:y.base},D.createElement(HW,{selected:A,disabled:v,onDesktopClick:()=>{}},D.createElement("span",{"data-testid":"model-selector-effort-group","data-model-base":y.base},y.base)),D.createElement(yW,{side:"right",align:"start",className:"min-w-40"},null));return D.createElement(zW,{"data-testid":"model-selector-item","data-model-label":a.label,selected:t,disabled:v,onClick:()=>{}},null);};
      var i0c=({group:a})=>D.createElement("div",{className:"flex flex-col gap-px"},a.options.map(b=>D.createElement(h0c,{key:b.label,model:b})));
      var j0c=()=>{var {groups:a,refreshModels:b,customModels:c,onAddCustomModel:d,onEditCustomModel:f,showCustomModelHeader:g,bestOfNConfig:h,isModelListLoading:k}=p6(),{scrollRef:l,overflow:m,onScroll:n}=tA(),p=h?.isBestOfNEnabled??!1;if(k)return D.createElement(g0c,{refreshModels:b});var q=a.some(t=>t.options.length>0);p=D.createElement(D.Fragment,null,D.createElement("div",{"data-testid":"model-selector-header",className:"text-sm px-2 pb-1 text-muted-foreground font-medium"},p?"Best of N Models":"Model"),q?a.map(t=>t.options.length>0&&D.createElement(i0c,{key:t.groupName,group:t})):D.createElement("div",{"data-testid":"model-selector-empty",className:"flex flex-col items-center gap-3 px-2 py-4"},D.createElement("span",{className:"text-sm opacity-50"},"No models available"),D.createElement(f0c,{refreshModels:b})),g&&D.createElement(e0c,{customModels:c,onAddCustomModel:d,onEditCustomModel:f}));return D.createElement("div",{className:"relative flex flex-col flex-grow min-h-0"},D.createElement("div",{ref:l,onScroll:n,className:"flex flex-col flex-grow min-h-0 pt-0 overflow-y-auto overscroll-y-none pb-1 gap-px scrollbar-none"},p),m.top&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-b pointer-events-none absolute top-0 left-0 right-0 h-6 from-card to-transparent"}),m.bottom&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-t pointer-events-none absolute bottom-0 left-0 right-0 h-6 from-card to-transparent"}))};
      var k0c=({extra:a}={})=>{return D.createElement(D.Fragment,null,(d||a)&&D.createElement(DW,null));};
    `;
    const result = patchMainJsModelSelector(sampleMainJs, 50999, {});
    expect(result.patched).toBe(true);
    expect(result.missed).toEqual([
      'effort order',
      'effort labels',
      'label effort pattern',
      'modelId effort pattern',
      'effort fallback',
      'effort fallback (ungrouped)',
    ]);
  });

  it('gracefully falls back when /main.js does not match expected structure', () => {
    const result = patchMainJsModelSelector('console.log("unrecognized");', 50999, {});
    expect(result.patched).toBe(false);
    expect(result.code).toBe('console.log("unrecognized");');
  });

  it('binds per-model block scope in renderProviderItems so clicking one model never selects the last model', () => {
    const sampleMainJs = `
      var h0c=({model:a})=>{return D.createElement(GW,{title:y.base},D.createElement(HW,{selected:A,disabled:v,onDesktopClick:()=>{}},D.createElement("span",{"data-testid":"model-selector-effort-group","data-model-base":y.base},y.base)),D.createElement(yW,{side:"right",align:"start",className:"min-w-40"},null));return D.createElement(zW,{"data-testid":"model-selector-item","data-model-label":a.label,selected:t,disabled:v,onClick:()=>{}},null);};
      var i0c=({group:a})=>D.createElement("div",{className:"flex flex-col gap-px"},a.options.map(b=>D.createElement(h0c,{key:b.label,model:b})));
      var j0c=()=>{var {groups:a,refreshModels:b,customModels:c,onAddCustomModel:d,onEditCustomModel:f,showCustomModelHeader:g,bestOfNConfig:h,isModelListLoading:k}=p6(),{scrollRef:l,overflow:m,onScroll:n}=tA(),p=h?.isBestOfNEnabled??!1;if(k)return D.createElement(g0c,{refreshModels:b});var q=a.some(t=>t.options.length>0);p=D.createElement(D.Fragment,null,D.createElement("div",{"data-testid":"model-selector-header",className:"text-sm px-2 pb-1 text-muted-foreground font-medium"},p?"Best of N Models":"Model"),q?a.map(t=>t.options.length>0&&D.createElement(i0c,{key:t.groupName,group:t})):D.createElement("div",{"data-testid":"model-selector-empty",className:"flex flex-col items-center gap-3 px-2 py-4"},D.createElement("span",{className:"text-sm opacity-50"},"No models available"),D.createElement(f0c,{refreshModels:b})),g&&D.createElement(e0c,{customModels:c,onAddCustomModel:d,onEditCustomModel:f}));return D.createElement("div",{className:"relative flex flex-col flex-grow min-h-0"},D.createElement("div",{ref:l,onScroll:n,className:"flex flex-col flex-grow min-h-0 pt-0 overflow-y-auto overscroll-y-none pb-1 gap-px scrollbar-none"},p),m.top&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-b pointer-events-none absolute top-0 left-0 right-0 h-6 from-card to-transparent"}),m.bottom&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-t pointer-events-none absolute bottom-0 left-0 right-0 h-6 from-card to-transparent"}))};
      var k0c=({extra:a}={})=>{return D.createElement(D.Fragment,null,(d||a)&&D.createElement(DW,null));};
    `;
    const result = patchMainJsModelSelector(sampleMainJs, 50999, {});
    expect(result.code).toContain('for(let [base,vars] of byBase.entries())');
    expect(result.code).toContain('let defV=selV||vars.find(v=>v.eff==="Medium")||vars[0];');
    expect(result.code).not.toContain('var defV=');
  });

  it('does not expand $&, $\', $`, or $$ in user model or provider names when patching /main.js', () => {
    const sampleMainJs = `
      var h0c=({model:a})=>{return D.createElement(GW,{title:y.base},D.createElement(HW,{selected:A,disabled:v,onDesktopClick:()=>{}},D.createElement("span",{"data-testid":"model-selector-effort-group","data-model-base":y.base},y.base)),D.createElement(yW,{side:"right",align:"start",className:"min-w-40"},null));return D.createElement(zW,{"data-testid":"model-selector-item","data-model-label":a.label,selected:t,disabled:v,onClick:()=>{}},null);};
      var i0c=({group:a})=>D.createElement("div",{className:"flex flex-col gap-px"},a.options.map(b=>D.createElement(h0c,{key:b.label,model:b})));
      var j0c=()=>{var {groups:a,refreshModels:b,customModels:c,onAddCustomModel:d,onEditCustomModel:f,showCustomModelHeader:g,bestOfNConfig:h,isModelListLoading:k}=p6(),{scrollRef:l,overflow:m,onScroll:n}=tA(),p=h?.isBestOfNEnabled??!1;if(k)return D.createElement(g0c,{refreshModels:b});var q=a.some(t=>t.options.length>0);p=D.createElement(D.Fragment,null,D.createElement("div",{"data-testid":"model-selector-header",className:"text-sm px-2 pb-1 text-muted-foreground font-medium"},p?"Best of N Models":"Model"),q?a.map(t=>t.options.length>0&&D.createElement(i0c,{key:t.groupName,group:t})):D.createElement("div",{"data-testid":"model-selector-empty",className:"flex flex-col items-center gap-3 px-2 py-4"},D.createElement("span",{className:"text-sm opacity-50"},"No models available"),D.createElement(f0c,{refreshModels:b})),g&&D.createElement(e0c,{customModels:c,onAddCustomModel:d,onEditCustomModel:f}));return D.createElement("div",{className:"relative flex flex-col flex-grow min-h-0"},D.createElement("div",{ref:l,onScroll:n,className:"flex flex-col flex-grow min-h-0 pt-0 overflow-y-auto overscroll-y-none pb-1 gap-px scrollbar-none"},p),m.top&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-b pointer-events-none absolute top-0 left-0 right-0 h-6 from-card to-transparent"}),m.bottom&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-t pointer-events-none absolute bottom-0 left-0 right-0 h-6 from-card to-transparent"}))};
      var k0c=({extra:a}={})=>{return D.createElement(D.Fragment,null,(d||a)&&D.createElement(DW,null));};
    `;
    const providerName = 'Price $& $\' $` $$ AI';
    const result = patchMainJsModelSelector(sampleMainJs, 50999, {
      'model $& $` $$': { providerName },
    });
    expect(result.patched).toBe(true);
    expect(result.code).toContain(JSON.stringify(providerName));
    expect(() => new Function(result.code)).not.toThrow();
  });

  it('dynamically extracts renamed effort parser helper and skips fallback patches when absent', () => {
    const base = `
      var h0c=({model:a})=>{return D.createElement(GW,{title:y.base},D.createElement(HW,{selected:A,disabled:v,onDesktopClick:()=>{}},D.createElement("span",{"data-testid":"model-selector-effort-group","data-model-base":y.base},y.base)),D.createElement(yW,{side:"right",align:"start",className:"min-w-40"},null));return D.createElement(zW,{"data-testid":"model-selector-item","data-model-label":a.label,selected:t,disabled:v,onClick:()=>{}},null);};
      var i0c=({group:a})=>D.createElement("div",{className:"flex flex-col gap-px"},a.options.map(b=>D.createElement(h0c,{key:b.label,model:b})));
      var j0c=()=>{var {groups:a,refreshModels:b,customModels:c,onAddCustomModel:d,onEditCustomModel:f,showCustomModelHeader:g,bestOfNConfig:h,isModelListLoading:k}=p6(),{scrollRef:l,overflow:m,onScroll:n}=tA(),p=h?.isBestOfNEnabled??!1;if(k)return D.createElement(g0c,{refreshModels:b});var q=a.some(t=>t.options.length>0);p=D.createElement(D.Fragment,null,D.createElement("div",{"data-testid":"model-selector-header",className:"text-sm px-2 pb-1 text-muted-foreground font-medium"},p?"Best of N Models":"Model"),q?a.map(t=>t.options.length>0&&D.createElement(i0c,{key:t.groupName,group:t})):D.createElement("div",{"data-testid":"model-selector-empty",className:"flex flex-col items-center gap-3 px-2 py-4"},D.createElement("span",{className:"text-sm opacity-50"},"No models available"),D.createElement(f0c,{refreshModels:b})),g&&D.createElement(e0c,{customModels:c,onAddCustomModel:d,onEditCustomModel:f}));return D.createElement("div",{className:"relative flex flex-col flex-grow min-h-0"},D.createElement("div",{ref:l,onScroll:n,className:"flex flex-col flex-grow min-h-0 pt-0 overflow-y-auto overscroll-y-none pb-1 gap-px scrollbar-none"},p),m.top&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-b pointer-events-none absolute top-0 left-0 right-0 h-6 from-card to-transparent"}),m.bottom&&D.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-t pointer-events-none absolute bottom-0 left-0 right-0 h-6 from-card to-transparent"}))};
      var k0c=({extra:a}={})=>{return D.createElement(D.Fragment,null,(d||a)&&D.createElement(DW,null));};
      const gSb=["low","medium","high","xhigh","max"],aW={low:"Low",medium:"Medium",high:"High",xhigh:"Extra",max:"Max"},hSb=new Map,iSb=/^(.*?)\\s*\\((low|medium|high|xhigh|max)(?:\\s+thinking)?\\)\\s*$/i;
      const lW=/-(low|medium|high|xhigh|max)$/;
    `;
    const withRenamedParser =
      base +
      `var jSb=a=>{if(a=iSb.exec(a))return{base:a[1].trim(),effort:a[2].toLowerCase()}},parseEff=a=>hSb.get(a.value)??jSb(a.label);` +
      `var nSb=(a,b)=>{var c=cW.get(b);if(c)return c=(b=fW(c,a))?c.groupsByKey.get(b.groupKey):void 0,b&&c&&c.byEffort.size>=2?{name:c.displayName,effort:b.effort}:{name:a.label};b=(c=hW(a,b))?parseEff(a):void 0;return c&&b?{name:c.base,effort:b.effort}:{name:a.label}};`;
    const renamed = patchMainJsModelSelector(withRenamedParser, 50999, {});
    expect(renamed.missed).toEqual([]);
    expect(renamed.code).toContain('(b=parseEff(a))?{name:b.base,effort:b.effort}:{name:a.label};');
    expect(renamed.code).not.toContain('bW(a)');
    expect(() => new Function(renamed.code)).not.toThrow();

    const withoutParser =
      base +
      `var nSb=(a,b)=>{var c=cW.get(b);if(c)return c=(b=fW(c,a))?c.groupsByKey.get(b.groupKey):void 0,b&&c&&c.byEffort.size>=2?{name:c.displayName,effort:b.effort}:{name:a.label};b=c?unknown(a,b):void 0;return c&&b?{name:c.base,effort:b.effort}:{name:a.label}};`;
    const skipped = patchMainJsModelSelector(withoutParser, 50999, {});
    expect(skipped.missed).toEqual(['effort fallback', 'effort fallback (ungrouped)']);
    expect(skipped.code).not.toContain('bW(a)');
    expect(() => new Function(skipped.code)).not.toThrow();
  });

  it('escapes $ in minified React identifier and avoids redundant refreshModels on initial mount', async () => {
    const sampleMainJs = `
      var h0c=({model:a})=>{return $R.createElement(GW,{title:y.base},$R.createElement(HW,{selected:A,disabled:v,onDesktopClick:()=>{}},$R.createElement("span",{"data-testid":"model-selector-effort-group","data-model-base":y.base},y.base)),$R.createElement(yW,{side:"right",align:"start",className:"min-w-40"},null));return $R.createElement(zW,{"data-testid":"model-selector-item","data-model-label":a.label,selected:t,disabled:v,onClick:()=>{}},null);};
      var i0c=({group:a})=>$R.createElement("div",{className:"flex flex-col gap-px"},a.options.map(b=>$R.createElement(h0c,{key:b.label,model:b})));
      var j0c=()=>{var {groups:a,refreshModels:b,customModels:c,onAddCustomModel:d,onEditCustomModel:f,showCustomModelHeader:g,bestOfNConfig:h,isModelListLoading:k}=p6(),{scrollRef:l,overflow:m,onScroll:n}=tA(),p=h?.isBestOfNEnabled??!1;if(k)return $R.createElement(g0c,{refreshModels:b});var q=a.some(t=>t.options.length>0);p=$R.createElement($R.Fragment,null,$R.createElement("div",{"data-testid":"model-selector-header",className:"text-sm px-2 pb-1 text-muted-foreground font-medium"},p?"Best of N Models":"Model"),q?a.map(t=>t.options.length>0&&$R.createElement(i0c,{key:t.groupName,group:t})):$R.createElement("div",{"data-testid":"model-selector-empty",className:"flex flex-col items-center gap-3 px-2 py-4"},$R.createElement("span",{className:"text-sm opacity-50"},"No models available"),$R.createElement(f0c,{refreshModels:b})),g&&$R.createElement(e0c,{customModels:c,onAddCustomModel:d,onEditCustomModel:f}));return $R.createElement("div",{className:"relative flex flex-col flex-grow min-h-0"},$R.createElement("div",{ref:l,onScroll:n,className:"flex flex-col flex-grow min-h-0 pt-0 overflow-y-auto overscroll-y-none pb-1 gap-px scrollbar-none"},p),m.top&&$R.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-b pointer-events-none absolute top-0 left-0 right-0 h-6 from-card to-transparent"}),m.bottom&&$R.createElement("div",{"aria-hidden":"true",className:"bg-gradient-to-t pointer-events-none absolute bottom-0 left-0 right-0 h-6 from-card to-transparent"}))};
      var k0c=({extra:a}={})=>{return $R.createElement($R.Fragment,null,(d||a)&&$R.createElement(DW,null));};
    `;
    const initialMap = { 'my-model': { providerName: 'My Provider' } };
    const result = patchMainJsModelSelector(sampleMainJs, 50999, initialMap);
    expect(result.patched).toBe(true);
    expect(result.code).toContain('$R.createElement(GW,{key:"prov_"+pn,title:pn}');

    // Execute patched j0c with minimal React stubs and verify unchanged provider map does not trigger refreshModels()
    let refreshCount = 0;
    const effects: Array<() => void> = [];
    const fakeWindow: Record<string, unknown> = {};
    const fakeReact = {
      Fragment: Symbol('Fragment'),
      createElement: () => ({}),
      useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
      useEffect: (fn: () => void) => effects.push(fn),
    };
    const fn = new Function(
      '$R',
      'p6',
      'tA',
      'GW',
      'HW',
      'yW',
      'zW',
      'DW',
      'g0c',
      'f0c',
      'e0c',
      'window',
      'document',
      'fetch',
      `${result.code}\nreturn j0c;`,
    );
    const j0c = fn(
      fakeReact,
      () => ({
        groups: [],
        refreshModels: () => {
          refreshCount++;
        },
        customModels: [],
        onAddCustomModel: () => {},
        onEditCustomModel: () => {},
        showCustomModelHeader: false,
        bestOfNConfig: null,
        isModelListLoading: false,
        selectedModel: null,
        setSelectedModel: () => {},
      }),
      () => ({ scrollRef: null, overflow: { top: false, bottom: false }, onScroll: () => {} }),
      'GW',
      'HW',
      'yW',
      'zW',
      'DW',
      'g0c',
      'f0c',
      'e0c',
      fakeWindow,
      { documentElement: { dataset: {} } },
      async () => ({ ok: true, json: async () => initialMap }),
    );
    j0c();
    expect(fakeWindow.__AGY_PROVIDERS_INIT__).toEqual(initialMap);
    for (const eff of effects) eff();
    await new Promise((r) => setTimeout(r, 0));
    expect(refreshCount).toBe(0);
  });
});
