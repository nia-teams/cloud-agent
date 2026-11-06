export interface RepairResult {
    parsed: Record<string, unknown>;
    repairedJson: string;
    rule: 'pristine' | 'reserialized' | 'trailing_comma' | 'autoclose' | 'trim_excess' | 'control_char_escape';
}
export interface RepairOptions {
    allowAutoclose?: boolean;
}
export function repairToolInputJson(raw: string, options: RepairOptions = {}): RepairResult | null {
    const allowAutoclose = options.allowAutoclose ?? false;
    const stripped = raw.trim();
    if (!stripped)
        return { parsed: {}, repairedJson: '{}', rule: 'pristine' };
    try {
        const parsed = JSON.parse(stripped);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
                parsed: parsed as Record<string, unknown>,
                repairedJson: stripped,
                rule: 'pristine',
            };
        }
    }
    catch {
    }
    const ctrlFixed = escapeBareControlCharsInStrings(stripped);
    if (ctrlFixed !== stripped) {
        try {
            const parsed = JSON.parse(ctrlFixed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    parsed: parsed as Record<string, unknown>,
                    repairedJson: ctrlFixed,
                    rule: 'control_char_escape',
                };
            }
        }
        catch {
        }
    }
    const commaFixed = stripTrailingCommasOutsideStrings(ctrlFixed);
    if (commaFixed !== ctrlFixed) {
        try {
            const parsed = JSON.parse(commaFixed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    parsed: parsed as Record<string, unknown>,
                    repairedJson: commaFixed,
                    rule: 'trailing_comma',
                };
            }
        }
        catch {
        }
    }
    if (!allowAutoclose) {
        return null;
    }
    let fixed = commaFixed;
    const openStack = scanOpenStack(fixed);
    if (openStack.length > 0) {
        const closing = openStack
            .reverse()
            .map((c) => (c === '{' ? '}' : ']'))
            .join('');
        const candidate = fixed + closing;
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    parsed: parsed as Record<string, unknown>,
                    repairedJson: candidate,
                    rule: 'autoclose',
                };
            }
        }
        catch {
            fixed = candidate;
        }
    }
    const orphanFixed = removeOrphanClosers(fixed);
    if (orphanFixed !== fixed) {
        try {
            const parsed = JSON.parse(orphanFixed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    parsed: parsed as Record<string, unknown>,
                    repairedJson: orphanFixed,
                    rule: 'trim_excess',
                };
            }
            fixed = orphanFixed;
        }
        catch {
            fixed = orphanFixed;
        }
    }
    for (let i = 0; i < 50; i++) {
        try {
            const parsed = JSON.parse(fixed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return {
                    parsed: parsed as Record<string, unknown>,
                    repairedJson: fixed,
                    rule: 'trim_excess',
                };
            }
            break;
        }
        catch {
            const last = fixed[fixed.length - 1];
            if (last === '}' &&
                countOutsideStrings(fixed, '}') > countOutsideStrings(fixed, '{')) {
                fixed = fixed.slice(0, -1);
            }
            else if (last === ']' &&
                countOutsideStrings(fixed, ']') > countOutsideStrings(fixed, '[')) {
                fixed = fixed.slice(0, -1);
            }
            else {
                break;
            }
        }
    }
    return null;
}
function escapeBareControlCharsInStrings(raw: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            if (ch === '\\' && i + 1 < raw.length) {
                out += ch + raw[i + 1];
                i++;
                continue;
            }
            if (ch === '"') {
                inString = false;
                out += ch;
                continue;
            }
            const code = ch.charCodeAt(0);
            if (code < 0x20) {
                out += '\\u' + code.toString(16).padStart(4, '0');
                continue;
            }
            out += ch;
        }
        else {
            if (ch === '"')
                inString = true;
            out += ch;
        }
    }
    return out;
}
function stripTrailingCommasOutsideStrings(raw: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
            out += ch;
            if (ch === '\\' && i + 1 < raw.length) {
                out += raw[i + 1];
                i++;
                continue;
            }
            if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === ',') {
            let j = i + 1;
            while (j < raw.length && /\s/.test(raw[j]))
                j++;
            if (j < raw.length && (raw[j] === '}' || raw[j] === ']')) {
                continue;
            }
        }
        out += ch;
    }
    return out;
}
function removeOrphanClosers(s: string): string {
    let out = '';
    const stack: string[] = [];
    let inString = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            out += ch;
            if (ch === '\\' && i + 1 < s.length) {
                out += s[i + 1];
                i++;
                continue;
            }
            if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === '{' || ch === '[') {
            stack.push(ch);
            out += ch;
        }
        else if (ch === '}' || ch === ']') {
            const expect = ch === '}' ? '{' : '[';
            if (stack[stack.length - 1] === expect) {
                stack.pop();
                out += ch;
            }
        }
        else {
            out += ch;
        }
    }
    return out;
}
function scanOpenStack(s: string): string[] {
    const stack: string[] = [];
    let inString = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === '\\' && i + 1 < s.length) {
                i++;
                continue;
            }
            if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{' || ch === '[') {
            stack.push(ch);
        }
        else if (ch === '}' || ch === ']') {
            const expect = ch === '}' ? '{' : '[';
            if (stack[stack.length - 1] === expect) {
                stack.pop();
            }
        }
    }
    return stack;
}
function countOutsideStrings(s: string, target: string): number {
    let count = 0;
    let inString = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === '\\' && i + 1 < s.length) {
                i++;
                continue;
            }
            if (ch === '"')
                inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === target)
            count++;
    }
    return count;
}
