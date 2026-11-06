import { fetch as undiciFetch, FormData as UndiciFormData, type Dispatcher } from 'undici';
import { scopeLogger, type Logger } from './logger.js';
import { createProxyDispatcher } from './proxy-dispatcher.js';
const DEFAULT_TIMEOUT_MS = 300000;
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export type ImageAspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
export type ImageSizeTier = '1K' | '2K';
export interface GenerateImageOptions {
    protocol: 'openai-images' | 'chat-multimodal';
    model: string;
    apiKey: string;
    baseURL?: string;
    prompt: string;
    referenceImage?: {
        buffer: Buffer;
        mime: string;
    };
    aspectRatio?: ImageAspectRatio;
    imageSize?: ImageSizeTier;
    extraHeaders?: Record<string, string>;
    proxyUrl?: string;
    dispatcher?: Dispatcher;
    signal?: AbortSignal;
    timeoutMs?: number;
    logger?: Logger;
    purpose?: string;
    sessionId?: string;
}
export interface GenerateImageResult {
    imageBuffer: Buffer;
    mime: ImageMime;
    usage: {
        inputTokens?: number;
        outputTokens?: number;
        usdCost?: number;
    };
    upstreamRequestId?: string;
}
interface ChatImageResponseShape {
    choices?: Array<{
        message?: {
            content?: string;
            images?: Array<{
                image_url?: {
                    url?: string;
                };
                type?: string;
            }>;
        };
    }>;
    usage?: {
        cost?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    error?: {
        message?: string;
        code?: number | string;
    };
}
function decodeDataUri(url: string): {
    buffer: Buffer;
    mime: ImageMime;
} | null {
    const m = /^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(url);
    if (!m)
        return null;
    const rawMime = m[1].toLowerCase();
    const mime = (rawMime === 'image/jpg' ? 'image/jpeg' : rawMime) as ImageMime;
    return { buffer: Buffer.from(m[3], 'base64'), mime };
}
function pickUpstreamRequestId(headers: Headers): string | undefined {
    for (const name of ['x-request-id', 'x-oneapi-request-id', 'x-trace-id']) {
        const v = headers.get(name);
        if (v)
            return v;
    }
    return undefined;
}
function combineAbort(external: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal;
    cancel: () => void;
} {
    const ac = new AbortController();
    const onExternal = () => ac.abort(external?.reason);
    if (external) {
        if (external.aborted)
            ac.abort(external.reason);
        else
            external.addEventListener('abort', onExternal, { once: true });
    }
    const timer = setTimeout(() => ac.abort(new Error(`image generation timed out after ${timeoutMs}ms`)), timeoutMs);
    return {
        signal: ac.signal,
        cancel: () => {
            clearTimeout(timer);
            if (external)
                external.removeEventListener('abort', onExternal);
        },
    };
}
const ALLOWED_REFERENCE_MIMES = Object.freeze([
    'image/png',
    'image/jpeg',
    'image/webp',
]);
async function generateChatImage(opts: GenerateImageOptions, apiModel: string): Promise<GenerateImageResult> {
    const log = scopeLogger(opts.logger, 'llm:image');
    const credentials = { ...opts, baseURL: opts.baseURL ?? "https://api.openai.com/v1" };
    if (!credentials.apiKey?.trim()) {
        throw new Error('[@nia-teams/ai] generateImage: protocol=chat-multimodal requires apiKey.');
    }
    let userContent: unknown;
    if (opts.referenceImage) {
        const refMime = opts.referenceImage.mime.toLowerCase();
        if (!ALLOWED_REFERENCE_MIMES.includes(refMime)) {
            throw new Error(`[@nia-teams/ai] generateImage: referenceImage.mime="${opts.referenceImage.mime}" is unsupported; ` +
                `allowed MIME types: ${[...ALLOWED_REFERENCE_MIMES].join(' / ')}; convert the reference image before calling.`);
        }
        const dataUri = `data:${refMime};base64,${opts.referenceImage.buffer.toString('base64')}`;
        userContent = [
            { type: 'text', text: opts.prompt },
            { type: 'image_url', image_url: { url: dataUri } },
        ];
    }
    else {
        userContent = opts.prompt;
    }
    const imageConfig: Record<string, string> = {};
    if (opts.aspectRatio)
        imageConfig.aspect_ratio = opts.aspectRatio;
    if (opts.imageSize)
        imageConfig.image_size = opts.imageSize;
    const requestBody = {
        model: apiModel,
        messages: [{ role: 'user', content: userContent }],
        modalities: ['image', 'text'],
        ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
        usage: { include: true },
    };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { signal, cancel } = combineAbort(opts.signal, timeoutMs);
    const dispatcher = opts.dispatcher;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey.trim()}`,
        ...credentials.extraHeaders,
    };
    log.info({
        model: opts.model,
        apiModel,
        purpose: opts.purpose || 'image',
        sessionId: opts.sessionId,
        hasReference: !!opts.referenceImage,
        hasProxy: !!credentials.proxyUrl,
    }, 'generateImage → Chat multimodal');
    try {
        const res = await undiciFetch(`${(credentials.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal,
            dispatcher,
        });
        const upstreamRequestId = pickUpstreamRequestId(res.headers as unknown as Headers);
        if (!res.ok) {
            let errText = '';
            try {
                errText = (await res.text()).slice(0, 500);
            }
            catch {
            }
            throw new Error(`[@nia-teams/ai] generateImage: Chat multimodal HTTP ${res.status}${errText ? ` · ${errText}` : ''}${upstreamRequestId ? ` · x-request-id=${upstreamRequestId}` : ''}`);
        }
        const json = (await res.json()) as ChatImageResponseShape;
        if (json.error) {
            throw new Error(`[@nia-teams/ai] generateImage: Chat multimodal API error · ${json.error.message || 'unknown'}${upstreamRequestId ? ` · x-request-id=${upstreamRequestId}` : ''}`);
        }
        const msg = json.choices?.[0]?.message;
        const imageUrl = msg?.images?.[0]?.image_url?.url;
        if (!imageUrl) {
            throw new Error(`[@nia-teams/ai] generateImage: Chat multimodal returned no image data in choices[0].message.images${upstreamRequestId ? ` · x-request-id=${upstreamRequestId}` : ''}`);
        }
        const decoded = decodeDataUri(imageUrl);
        if (!decoded) {
            throw new Error(`[@nia-teams/ai] generateImage: Chat multimodal returned an unsupported image data URI: ${imageUrl.slice(0, 80)}`);
        }
        return {
            imageBuffer: decoded.buffer,
            mime: decoded.mime,
            usage: {
                inputTokens: json.usage?.prompt_tokens,
                outputTokens: json.usage?.completion_tokens,
                usdCost: typeof json.usage?.cost === 'number' ? json.usage.cost : undefined,
            },
            upstreamRequestId,
        };
    }
    finally {
        cancel();
    }
}
interface OpenAIImagesResponseShape {
    data?: Array<{
        b64_json?: string;
        url?: string;
    }>;
    output_format?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
    };
    error?: {
        message?: string;
        type?: string;
        code?: string;
    };
}
function extForReferenceMime(mime: string): string {
    switch (mime) {
        case 'image/png':
            return 'png';
        case 'image/webp':
            return 'webp';
        default:
            return 'jpg';
    }
}
function mimeForOutputFormat(format: string | undefined): ImageMime {
    switch ((format || '').toLowerCase()) {
        case 'jpeg':
        case 'jpg':
            return 'image/jpeg';
        case 'webp':
            return 'image/webp';
        default:
            return 'image/png';
    }
}
async function generateOpenAIImage(opts: GenerateImageOptions, apiModel: string): Promise<GenerateImageResult> {
    const log = scopeLogger(opts.logger, 'llm:image');
    const credentials = { ...opts, baseURL: opts.baseURL ?? "https://api.openai.com/v1" };
    if (!credentials.baseURL?.trim()) {
        throw new Error('[@nia-teams/ai] generateImage: protocol=openai-images requires baseURL.');
    }
    if (!credentials.apiKey?.trim()) {
        throw new Error('[@nia-teams/ai] generateImage: protocol=openai-images requires apiKey.');
    }
    const isEdit = !!opts.referenceImage;
    const endpoint = `${credentials.baseURL.replace(/\/+$/, '')}/images/${isEdit ? 'edits' : 'generations'}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${credentials.apiKey.trim()}`, ...opts.extraHeaders };
    let body: string | UndiciFormData;
    if (opts.referenceImage) {
        const refMime = opts.referenceImage.mime.toLowerCase();
        if (!ALLOWED_REFERENCE_MIMES.includes(refMime)) {
            throw new Error(`[@nia-teams/ai] generateImage: referenceImage.mime="${opts.referenceImage.mime}" is unsupported; ` +
                `allowed MIME types: ${[...ALLOWED_REFERENCE_MIMES].join(' / ')}; convert the reference image before calling.`);
        }
        const form = new UndiciFormData();
        form.append('model', apiModel);
        form.append('prompt', opts.prompt);
        form.append('image', new Blob([new Uint8Array(opts.referenceImage.buffer)], { type: refMime }), `reference.${extForReferenceMime(refMime)}`);
        body = form;
    }
    else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ model: apiModel, prompt: opts.prompt });
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { signal, cancel } = combineAbort(opts.signal, timeoutMs);
    const dispatcher = opts.dispatcher;
    log.info({
        model: opts.model,
        apiModel,
        purpose: opts.purpose || 'image',
        sessionId: opts.sessionId,
        mode: isEdit ? 'edits' : 'generations',
        hasProxy: !!credentials.proxyUrl,
    }, 'generateImage → Images API');
    try {
        const res = await undiciFetch(endpoint, {
            method: 'POST',
            headers,
            body: body as never,
            signal,
            dispatcher,
        });
        const upstreamRequestId = pickUpstreamRequestId(res.headers as unknown as Headers);
        if (!res.ok) {
            let errText = '';
            try {
                errText = (await res.text()).slice(0, 500);
            }
            catch {
            }
            throw new Error(`[@nia-teams/ai] generateImage: Images API HTTP ${res.status}${errText ? ` · ${errText}` : ''}${upstreamRequestId ? ` · x-request-id=${upstreamRequestId}` : ''}`);
        }
        const json = (await res.json()) as OpenAIImagesResponseShape;
        if (json.error) {
            throw new Error(`[@nia-teams/ai] generateImage: Images API API error · ${json.error.message || 'unknown'}${upstreamRequestId ? ` · x-request-id=${upstreamRequestId}` : ''}`);
        }
        const b64 = json.data?.[0]?.b64_json;
        if (!b64) {
            throw new Error(`[@nia-teams/ai] generateImage: Images API returned no b64_json image data in data[0]${json.data?.[0]?.url ? '; URL-only image responses are not supported' : ''}${upstreamRequestId ? ` · x-request-id=${upstreamRequestId}` : ''}`);
        }
        return {
            imageBuffer: Buffer.from(b64, 'base64'),
            mime: mimeForOutputFormat(json.output_format),
            usage: {
                inputTokens: json.usage?.input_tokens,
                outputTokens: json.usage?.output_tokens,
                usdCost: undefined,
            },
            upstreamRequestId,
        };
    }
    finally {
        cancel();
    }
}
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    options.signal?.throwIfAborted();
    const owned = options.dispatcher ? undefined : createProxyDispatcher(options.proxyUrl);
    const opts = { ...options, dispatcher: options.dispatcher ?? owned };
    try {
        switch (opts.protocol) {
            case 'openai-images': return await generateOpenAIImage(opts, opts.model);
            case 'chat-multimodal': return await generateChatImage(opts, opts.model);
            default: throw new Error('Unsupported image wire protocol');
        }
    }
    finally {
        await owned?.close();
    }
}
