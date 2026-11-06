import { describe, expect, it } from 'vitest';
import { repairToolInputJson } from '../clients/tool-input-repair.js';
describe('repairToolInputJson', () => {
    it('returns pristine for valid JSON object', () => {
        const res = repairToolInputJson('{"path":"a.txt","content":"hello"}', { allowAutoclose: false });
        expect(res).toEqual({
            parsed: { path: 'a.txt', content: 'hello' },
            repairedJson: '{"path":"a.txt","content":"hello"}',
            rule: 'pristine',
        });
    });
    it('repairs bare control chars inside strings (control_char_escape) when allowAutoclose is false', () => {
        const raw = '{"path":"a.txt","content":"line1\nline2\tend"}';
        const res = repairToolInputJson(raw, { allowAutoclose: false });
        expect(res?.rule).toBe('control_char_escape');
        expect(res?.parsed).toEqual({ path: 'a.txt', content: 'line1\nline2\tend' });
        expect(() => JSON.parse(res!.repairedJson)).not.toThrow();
    });
    it('repairs trailing commas outside strings without mutating `,}` inside string values', () => {
        const raw = '{"pattern":"foo,}","items":[1,2,],}';
        const res = repairToolInputJson(raw, { allowAutoclose: false });
        expect(res?.rule).toBe('trailing_comma');
        expect(res?.parsed).toEqual({ pattern: 'foo,}', items: [1, 2] });
        expect(() => JSON.parse(res!.repairedJson)).not.toThrow();
    });
    it('rejects truncated JSON and excess closers by default and when allowAutoclose is false', () => {
        expect(repairToolInputJson('{"path":"build/health-status.json","content":"{\\n  \\"subjects\\": [')).toBeNull();
        expect(repairToolInputJson('{"path":"build/health-status.json","content":"{\\n  \\"subjects\\": [', {
            allowAutoclose: false,
        })).toBeNull();
        expect(repairToolInputJson('{"path":"config/database.yml","content":"password: half', {
            allowAutoclose: true,
        })).toBeNull();
        expect(repairToolInputJson('{"path":"a.txt","content":"complete"')).toBeNull();
        expect(repairToolInputJson('{"path":"a.txt","content":"complete"', { allowAutoclose: false })).toBeNull();
        expect(repairToolInputJson('{"a":1}}')).toBeNull();
        expect(repairToolInputJson('{}""')).toBeNull();
    });
});
