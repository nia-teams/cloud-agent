export interface Logger {
    trace(obj: object | string, msg?: string): void;
    debug(obj: object | string, msg?: string): void;
    info(obj: object | string, msg?: string): void;
    warn(obj: object | string, msg?: string): void;
    error(obj: object | string, msg?: string): void;
    fatal?(obj: object | string, msg?: string): void;
    child?(bindings: Record<string, unknown>): Logger;
}
export const noopLogger: Logger = Object.freeze({
    trace() { }, debug() { }, info() { }, warn() { }, error() { }, fatal() { },
});
export function scopeLogger(logger: Logger | undefined, scope: string): Logger {
    if (!logger || logger === noopLogger)
        return noopLogger;
    if (logger.child)
        return logger.child({ scope });
    const wrap = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error') => (obj: object | string, msg?: string): void => {
        if (typeof obj === 'string')
            logger[level]({ scope }, obj);
        else
            logger[level]({ ...obj, scope }, msg);
    };
    return { trace: wrap('trace'), debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}
export const createChildLogger = scopeLogger;
