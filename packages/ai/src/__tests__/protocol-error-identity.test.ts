import { describe, expect, it } from 'vitest';
import { MalformedToolArgumentsError as ProtocolError } from '../protocol/index.js';
import { MalformedToolArgumentsError as ClientError } from '../clients/openai.js';
import { MalformedToolArgumentsError as RootError } from '../index.js';
import { MalformedToolArgumentsError as SharedError } from '@nia-teams/ai/protocol';
import { MalformedToolArgumentsError as RuntimeError } from '@nia-teams/ai/protocol';
describe('malformed-tool error identity', () => {
    it('shares exactly one constructor across protocol, client and root entry points', () => {
        expect(ClientError).toBe(SharedError);
        expect(ClientError).toBe(RuntimeError);
        expect(ClientError).toBe(ProtocolError);
        expect(RootError).toBe(ProtocolError);
        const error = new ClientError('call', 'tool', '{');
        expect(error).toBeInstanceOf(ProtocolError);
        expect(error).toBeInstanceOf(RootError);
        expect(error.upstreamRequestId).toBeNull();
        expect(error.upstreamCompletionId).toBeNull();
    });
});
