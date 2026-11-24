import type { CustomModel } from '../proxy';
export interface CustomProviderLookupEntry {
    providerName: string;
}
export declare function inferCustomProviderName(model: Pick<CustomModel, 'name' | 'displayName' | 'provider' | 'providerName'>): string;
export declare function normalizeModelLookupKey(label: string): string;
export declare function buildCustomProviderMap(models: CustomModel[]): Record<string, CustomProviderLookupEntry>;
export declare function patchMainJsModelSelector(source: string, proxyPort: number, initialProviderMap: Record<string, CustomProviderLookupEntry>): {
    code: string;
    patched: boolean;
    missed: string[];
};
//# sourceMappingURL=uiMitm.d.ts.map