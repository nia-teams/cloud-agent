import type { AgentMessage } from '@nia-teams/ai/protocol';
export interface AdapterCapabilities {
    supportsMidConversationTools?: boolean;
}
export interface ProviderAdapter {
    fromStorage(messages: AgentMessage[], systemPrompt: string, currentModel?: string, capabilities?: AdapterCapabilities): unknown[];
}
export function assertCanonicalMessages(messages: AgentMessage[]): void {
    const kinds = new Set(['event', 'assistant', 'tool', 'system_injection']);
    if (!Array.isArray(messages) || messages.some(message => !message || typeof message !== 'object' || !kinds.has(message.type))) {
        throw new TypeError('LLM client.chat requires canonical AgentMessage[]; provider-wire role/parts messages are not supported');
    }
}
