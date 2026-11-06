import { ProxyAgent, type Dispatcher } from 'undici';
export function createProxyDispatcher(proxyUrl?: string): Dispatcher | undefined {
    return proxyUrl ? new ProxyAgent({
        uri: proxyUrl,
        bodyTimeout: 30 * 60 * 1000,
        headersTimeout: 5 * 60 * 1000,
    }) : undefined;
}
