import { AnthropicClient, type AnthropicClientOptions } from './clients/anthropic.js';
import { OpenAIClient, type OpenAIClientOptions } from './clients/openai.js';
import { ResponsesClient, type ResponsesClientOptions } from './clients/responses.js';
import { GeminiClient, type GeminiClientOptions } from './clients/gemini.js';
import type { ILLMClient } from './protocol/index.js';
export type WireProtocol = 'anthropic' | 'openai-completions' | 'openai-responses' | 'gemini';
export type CreateClientOptions = ({
    protocol: 'anthropic';
} & AnthropicClientOptions) | ({
    protocol: 'openai-completions';
} & OpenAIClientOptions) | ({
    protocol: 'openai-responses';
} & ResponsesClientOptions) | ({
    protocol: 'gemini';
} & GeminiClientOptions);
export function createClient(options: CreateClientOptions): ILLMClient {
    switch (options.protocol) {
        case 'anthropic': return new AnthropicClient(options);
        case 'openai-completions': return new OpenAIClient(options);
        case 'openai-responses': return new ResponsesClient(options);
        case 'gemini': return new GeminiClient(options);
    }
}
