import type { AgentMessage, ConversationStore } from './types.js';
export class InMemoryConversationStore implements ConversationStore {
    private messages: AgentMessage[];
    private incoming: AgentMessage[] = [];
    constructor(initial: readonly AgentMessage[] = []) { this.messages = structuredClone([...initial]); }
    static fromUserMessage(content: string): InMemoryConversationStore {
        return new InMemoryConversationStore([{ type: 'event', eventType: 'user', timestamp: new Date(), content }]);
    }
    enqueue(...msgs: AgentMessage[]): void { this.incoming.push(...structuredClone(msgs)); }
    getMessages(): AgentMessage[] { return structuredClone([...this.messages, ...this.incoming]); }
    async loadAll(): Promise<AgentMessage[]> {
        this.messages.push(...this.incoming.splice(0));
        return structuredClone(this.messages);
    }
    async hasNew(): Promise<boolean> { return this.incoming.length > 0; }
    async fetchNew(): Promise<AgentMessage[]> {
        const batch = this.incoming.splice(0);
        this.messages.push(...batch);
        return structuredClone(batch);
    }
    async persist(messages: AgentMessage[]): Promise<void> { this.messages.push(...structuredClone(messages)); }
}
