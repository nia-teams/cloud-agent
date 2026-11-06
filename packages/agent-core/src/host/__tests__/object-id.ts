import { randomBytes } from 'node:crypto';
export class ObjectId {
    readonly _bsontype = 'ObjectId';
    private readonly hex: string;
    constructor(value?: string | ObjectId) {
        this.hex = value === undefined ? randomBytes(12).toString('hex') : String(value);
        if (!/^[0-9a-fA-F]{24}$/.test(this.hex))
            throw new Error('Invalid test identity');
    }
    toHexString(): string { return this.hex; }
    toString(): string { return this.hex; }
    equals(other: unknown): boolean { return String(other) === this.hex; }
}
