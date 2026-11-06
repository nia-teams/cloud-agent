import { describe, expect, it } from 'vitest';
import type { AiPostContext, ToolExecutionResult } from '../types.js';
import { renderAiPostContext } from '../ai-post-context.js';
describe('AI post-context contract', () => {
    it('renders generic strings, text objects and warnings', () => {
        const result: ToolExecutionResult = {
            content: 'business result',
            guidance: [{ kind: 'text', text: 'Next step: deploy' }],
        };
        expect(result.content).toBe('business result');
        expect(renderAiPostContext(result.guidance![0])).toBe('Next step: deploy');
        expect(renderAiPostContext('Host reminder')).toBe('Host reminder');
        expect(renderAiPostContext({ text: 'Legacy text object' } as AiPostContext)).toBe('Legacy text object');
        expect(renderAiPostContext({
            kind: 'tool_loop_warning', warningType: 'repeat', toolName: 'example', count: 3,
        })).toBe('[Tool loop warning: example repeat (3). Stop repeating the same call and try a different approach or report to the user.]');
        expect(renderAiPostContext({
            kind: 'tool_loop_warning', warningType: 'repeat', toolName: 'example', count: 3, message: 'Try another approach.',
        })).toBe('Try another approach.');
    });
});
