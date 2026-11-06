export interface RedisClientLike {
    publish(channel: string, payload: string): Promise<unknown>;
    subscribe(channel: string): Promise<unknown>;
    unsubscribe(channel: string): Promise<unknown>;
    psubscribe(pattern: string): Promise<unknown>;
    punsubscribe(pattern: string): Promise<unknown>;
    duplicate(): RedisClientLike;
    on(event: 'message', listener: (channel: string, message: string) => void): unknown;
    on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
    off(event: 'message', listener: (channel: string, message: string) => void): unknown;
    off(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): unknown;
    disconnect(): void;
}
import type { PubSub } from '../types.js';
export interface CreateRedisPubSubOpts {
    redis: RedisClientLike;
    keyPrefix?: string;
}
export function createRedisPubSub(opts: CreateRedisPubSubOpts): PubSub {
    const { redis } = opts;
    const prefix = opts.keyPrefix ?? '';
    function key(channel: string): string {
        return prefix ? `${prefix}${channel}` : channel;
    }
    return {
        async publish(channel, payload) {
            await redis.publish(key(channel), payload);
        },
        async subscribe(channel, handler) {
            const sub = redis.duplicate();
            const target = key(channel);
            const onMessage = (received: string, message: string): void => {
                if (received === target) {
                    try {
                        handler(message);
                    }
                    catch {
                    }
                }
            };
            sub.on('message', onMessage);
            await sub.subscribe(target);
            return async () => {
                try {
                    await sub.unsubscribe(target);
                }
                catch {
                }
                sub.off('message', onMessage);
                try {
                    sub.disconnect();
                }
                catch {
                }
            };
        },
        async psubscribe(pattern, handler) {
            const sub = redis.duplicate();
            const target = key(pattern);
            const onPMessage = (receivedPattern: string, channel: string, message: string): void => {
                if (receivedPattern === target) {
                    try {
                        const stripped = prefix && channel.startsWith(prefix)
                            ? channel.slice(prefix.length)
                            : channel;
                        handler(stripped, message);
                    }
                    catch {
                    }
                }
            };
            sub.on('pmessage', onPMessage);
            await sub.psubscribe(target);
            return async () => {
                try {
                    await sub.punsubscribe(target);
                }
                catch {
                }
                sub.off('pmessage', onPMessage);
                try {
                    sub.disconnect();
                }
                catch {
                }
            };
        },
    };
}
