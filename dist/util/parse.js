import * as yaml from "yaml";
import { extname } from "./extname.js";
export const loadFileContents = (contents, format) => {
    switch (format) {
        case ".json":
            return JSON.parse(contents);
        case ".yml":
        case ".yaml":
            return yaml.parse(contents);
        default:
            throw new Error(`Unsupported filetype ${format}`);
    }
};
export const parseFileConfig = (text, path, supportedTypes) => {
    const suffix = extname(path);
    if (![".json", ".yaml"].includes(suffix) ||
        (supportedTypes && !supportedTypes.includes(suffix))) {
        throw new Error(`Unsupported filetype ${suffix}`);
    }
    return loadFileContents(text, suffix);
};
