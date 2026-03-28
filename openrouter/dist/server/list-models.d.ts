export type AdapterModel = {
    id: string;
    label: string;
    supportsVision: boolean;
};
export declare function listOpenRouterModels(): Promise<AdapterModel[]>;
export declare function getModelFromLiveCache(model: string): AdapterModel | undefined;
export declare function _resetModelCacheForTesting(): void;
//# sourceMappingURL=list-models.d.ts.map