import { LangChainTracer } from "../callbacks/handlers/tracer_langchain.js";
import { mapStoredMessagesToChatMessages } from "../stores/message/utils.js";
import { AsyncCaller } from "../util/async_caller.js";
// utility functions
const isLocalhost = (url) => {
    const strippedUrl = url.replace("http://", "").replace("https://", "");
    const hostname = strippedUrl.split("/")[0].split(":")[0];
    return (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
};
const getSeededTenantId = async (apiUrl, apiKey, callerOptions = undefined) => {
    // Get the tenant ID from the seeded tenant
    const caller = new AsyncCaller(callerOptions ?? {});
    const url = `${apiUrl}/tenants`;
    let response;
    try {
        response = await caller.call(fetch, url, {
            method: "GET",
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
        });
    }
    catch (err) {
        throw new Error("Unable to get seeded tenant ID. Please manually provide.");
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch seeded tenant ID: ${response.status} ${response.statusText}`);
    }
    const tenants = await response.json();
    if (!Array.isArray(tenants)) {
        throw new Error(`Expected tenants GET request to return an array, but got ${tenants}`);
    }
    if (tenants.length === 0) {
        throw new Error("No seeded tenant found");
    }
    return tenants[0].id;
};
const stringifyError = (err) => {
    let result;
    if (err == null) {
        result = "Error null or undefined";
    }
    else {
        const error = err;
        result = `Error: ${error?.name}: ${error?.message}`;
    }
    return result;
};
export function isLLM(llm) {
    const blm = llm;
    return (typeof blm?._modelType === "function" && blm?._modelType() === "base_llm");
}
export function isChatModel(llm) {
    const blm = llm;
    return (typeof blm?._modelType === "function" &&
        blm?._modelType() === "base_chat_model");
}
export async function isChain(llm) {
    if (isLLM(llm)) {
        return false;
    }
    const bchFactory = llm;
    const bch = await bchFactory();
    return (typeof bch?._chainType === "function" && bch?._chainType() !== undefined);
}
async function getModelOrFactoryType(llm) {
    if (isLLM(llm)) {
        return "llm";
    }
    if (isChatModel(llm)) {
        return "chatModel";
    }
    const bchFactory = llm;
    const bch = await bchFactory();
    if (typeof bch?._chainType === "function") {
        return "chainFactory";
    }
    throw new Error("Unknown model or factory type");
}
export class LangChainPlusClient {
    constructor(apiUrl, tenantId, apiKey, callerOptions) {
        Object.defineProperty(this, "apiKey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "apiUrl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "tenantId", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "caller", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.tenantId = tenantId;
        this.validateApiKeyIfHosted();
        this.caller = new AsyncCaller(callerOptions ?? {});
    }
    static async create(apiUrl, apiKey = undefined) {
        const tenantId = await getSeededTenantId(apiUrl, apiKey);
        return new LangChainPlusClient(apiUrl, tenantId, apiKey);
    }
    validateApiKeyIfHosted() {
        const isLocal = isLocalhost(this.apiUrl);
        if (!isLocal && !this.apiKey) {
            throw new Error("API key must be provided when using hosted LangChain+ API");
        }
    }
    get headers() {
        const headers = {};
        if (this.apiKey) {
            headers.authorization = `Bearer ${this.apiKey}`;
        }
        return headers;
    }
    get queryParams() {
        return { tenant_id: this.tenantId };
    }
    async _get(path, queryParams = {}) {
        const params = { ...this.queryParams, ...queryParams };
        let queryString = "";
        for (const key in params) {
            if (Object.prototype.hasOwnProperty.call(params, key)) {
                queryString = queryString
                    ? `${queryString}&${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
                    : `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
            }
        }
        const url = `${this.apiUrl}${path}${queryString ? `?${queryString}` : ""}`;
        const response = await this.caller.call(fetch, url, {
            method: "GET",
            headers: this.headers,
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch ${path}: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }
    async uploadCsv(csvFile, fileName, description, inputKeys, outputKeys) {
        const url = `${this.apiUrl}/datasets/upload`;
        const formData = new FormData();
        formData.append("file", csvFile, fileName);
        formData.append("input_keys", inputKeys.join(","));
        formData.append("output_keys", outputKeys.join(","));
        formData.append("description", description);
        formData.append("tenant_id", this.tenantId);
        const response = await this.caller.call(fetch, url, {
            method: "POST",
            headers: this.headers,
            body: formData,
        });
        if (!response.ok) {
            const result = await response.json();
            if (result.detail && result.detail.includes("already exists")) {
                throw new Error(`Dataset ${fileName} already exists`);
            }
            throw new Error(`Failed to upload CSV: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        return result;
    }
    async createDataset(name, description) {
        const response = await this.caller.call(fetch, `${this.apiUrl}/datasets`, {
            method: "POST",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body: JSON.stringify({
                name,
                description,
                tenant_id: this.tenantId,
            }),
        });
        if (!response.ok) {
            const result = await response.json();
            if (result.detail && result.detail.includes("already exists")) {
                throw new Error(`Dataset ${name} already exists`);
            }
            throw new Error(`Failed to create dataset ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        return result;
    }
    async readDataset(datasetId, datasetName) {
        let path = "/datasets";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params = { limit: 1 };
        if (datasetId !== undefined && datasetName !== undefined) {
            throw new Error("Must provide either datasetName or datasetId, not both");
        }
        else if (datasetId !== undefined) {
            path += `/${datasetId}`;
        }
        else if (datasetName !== undefined) {
            params.name = datasetName;
        }
        else {
            throw new Error("Must provide datasetName or datasetId");
        }
        const response = await this._get(path, params);
        let result;
        if (Array.isArray(response)) {
            if (response.length === 0) {
                throw new Error(`Dataset[id=${datasetId}, name=${datasetName}] not found`);
            }
            result = response[0];
        }
        else {
            result = response;
        }
        return result;
    }
    async listDatasets(limit = 100) {
        const path = "/datasets";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params = { limit };
        const response = await this._get(path, params);
        if (!Array.isArray(response)) {
            throw new Error(`Expected ${path} to return an array, but got ${response}`);
        }
        return response;
    }
    async deleteDataset(datasetId, datasetName) {
        let path = "/datasets";
        let datasetId_ = datasetId;
        if (datasetId !== undefined && datasetName !== undefined) {
            throw new Error("Must provide either datasetName or datasetId, not both");
        }
        else if (datasetName !== undefined) {
            const dataset = await this.readDataset(undefined, datasetName);
            datasetId_ = dataset.id;
        }
        if (datasetId_ !== undefined) {
            path += `/${datasetId_}`;
        }
        else {
            throw new Error("Must provide datasetName or datasetId");
        }
        const response = await this.caller.call(fetch, this.apiUrl + path, {
            method: "DELETE",
            headers: this.headers,
        });
        if (!response.ok) {
            throw new Error(`Failed to delete ${path}: ${response.status} ${response.statusText}`);
        }
        const results = await response.json();
        return results;
    }
    async createExample(inputs, outputs = {}, datasetId = undefined, datasetName = undefined, createdAt = undefined) {
        let datasetId_ = datasetId;
        if (datasetId_ === undefined && datasetName === undefined) {
            throw new Error("Must provide either datasetName or datasetId");
        }
        else if (datasetId_ !== undefined && datasetName !== undefined) {
            throw new Error("Must provide either datasetName or datasetId, not both");
        }
        else if (datasetId_ === undefined) {
            const dataset = await this.readDataset(undefined, datasetName);
            datasetId_ = dataset.id;
        }
        const createdAt_ = createdAt || new Date();
        const data = {
            dataset_id: datasetId_,
            inputs,
            outputs,
            created_at: createdAt_.toISOString(),
        };
        const response = await this.caller.call(fetch, `${this.apiUrl}/examples`, {
            method: "POST",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`Failed to create example: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        return result;
    }
    async readExample(exampleId) {
        const path = `/examples/${exampleId}`;
        return await this._get(path);
    }
    async listExamples(datasetId = undefined, datasetName = undefined) {
        let datasetId_;
        if (datasetId !== undefined && datasetName !== undefined) {
            throw new Error("Must provide either datasetName or datasetId, not both");
        }
        else if (datasetId !== undefined) {
            datasetId_ = datasetId;
        }
        else if (datasetName !== undefined) {
            const dataset = await this.readDataset(undefined, datasetName);
            datasetId_ = dataset.id;
        }
        else {
            throw new Error("Must provide a datasetName or datasetId");
        }
        const response = await this._get("/examples", {
            dataset: datasetId_,
        });
        if (!Array.isArray(response)) {
            throw new Error(`Expected /examples to return an array, but got ${response}`);
        }
        return response;
    }
    async deleteExample(exampleId) {
        const path = `/examples/${exampleId}`;
        const response = await this.caller.call(fetch, this.apiUrl + path, {
            method: "DELETE",
            headers: this.headers,
        });
        if (!response.ok) {
            throw new Error(`Failed to delete ${path}: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        return result;
    }
    async runLLM(example, tracer, llm, numRepetitions = 1) {
        const results = await Promise.all(Array.from({ length: numRepetitions }).map(async () => {
            try {
                const prompt = example.inputs.prompt;
                return llm.generate([prompt], undefined, [tracer]);
            }
            catch (e) {
                console.error(e);
                return stringifyError(e);
            }
        }));
        return results;
    }
    async runChain(example, tracer, chainFactory, numRepetitions = 1) {
        const results = await Promise.all(Array.from({ length: numRepetitions }).map(async () => {
            try {
                const chain = await chainFactory();
                return chain.call(example.inputs, [tracer]);
            }
            catch (e) {
                console.error(e);
                return stringifyError(e);
            }
        }));
        return results;
    }
    async runChatModel(example, tracer, chatModel, numRepetitions = 1) {
        const results = await Promise.all(Array.from({ length: numRepetitions }).map(async () => {
            try {
                const messages = example.inputs.messages;
                return chatModel.generate([mapStoredMessagesToChatMessages(messages)], undefined, [tracer]);
            }
            catch (e) {
                console.error(e);
                return stringifyError(e);
            }
        }));
        return results;
    }
    async runOnDataset(datasetName, llmOrChainFactory, numRepetitions = 1, sessionName = undefined) {
        const examples = await this.listExamples(undefined, datasetName);
        let sessionName_;
        if (sessionName === undefined) {
            const currentTime = new Date().toISOString();
            sessionName_ = `${datasetName}-${llmOrChainFactory.constructor.name}-${currentTime}`;
        }
        else {
            sessionName_ = sessionName;
        }
        const results = {};
        const modelOrFactoryType = await getModelOrFactoryType(llmOrChainFactory);
        await Promise.all(examples.map(async (example) => {
            const tracer = new LangChainTracer({
                exampleId: example.id,
                sessionName: sessionName_,
            });
            if (modelOrFactoryType === "llm") {
                const llm = llmOrChainFactory;
                const llmResult = await this.runLLM(example, tracer, llm, numRepetitions);
                results[example.id] = llmResult;
            }
            else if (modelOrFactoryType === "chainFactory") {
                const chainFactory = llmOrChainFactory;
                const chainResult = await this.runChain(example, tracer, chainFactory, numRepetitions);
                results[example.id] = chainResult;
            }
            else if (modelOrFactoryType === "chatModel") {
                const chatModel = llmOrChainFactory;
                const chatModelResult = await this.runChatModel(example, tracer, chatModel, numRepetitions);
                results[example.id] = chatModelResult;
            }
            else {
                throw new Error(` llm or chain type: ${llmOrChainFactory}`);
            }
        }));
        return results;
    }
}
