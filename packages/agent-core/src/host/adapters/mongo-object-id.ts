export type ToObjectId = (hex24: string) => unknown;
export function objectIdConverter(source: unknown, override?: ToObjectId): ToObjectId {
    let factory = override;
    return (hex: string): unknown => {
        if (!/^[0-9a-fA-F]{24}$/.test(hex))
            return hex;
        if (!factory) {
            const owner = source as {
                s?: {
                    pkFactory?: {
                        createPk(): unknown;
                    };
                };
            };
            const sample = owner.s?.pkFactory?.createPk();
            if (sample && typeof sample === 'object' &&
                '_bsontype' in sample && sample._bsontype === 'ObjectId') {
                const Constructor = sample.constructor as new (hex: string) => unknown;
                factory = value => new Constructor(value);
            }
            else {
                throw new Error('Cannot discover BSON ObjectId constructor; pass toObjectId explicitly');
            }
        }
        return factory(hex);
    };
}
