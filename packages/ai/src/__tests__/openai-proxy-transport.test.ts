import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
it('bundled SDK streams and completes through a real CONNECT proxy without duplicate content-length', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'llm-proxy-transport-'));
    try {
        const outfile = join(directory, 'transport.mjs');
        await build({
            entryPoints: [fileURLToPath(new URL('./fixtures/openai-proxy-transport.ts', import.meta.url))],
            outfile,
            bundle: true,
            platform: 'node',
            target: 'node20',
            format: 'esm',
            banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
        });
        const { stdout } = await promisify(execFile)(process.execPath, [outfile], { timeout: 15000 });
        const result = JSON.parse(stdout.trim());
        expect(result.completed).toBe(6);
        expect(result.failures).toEqual([]);
        expect(result.connects).toBeGreaterThan(0);
        expect(result.diagnostics.find((item: {
            label: string;
        }) => item.label === 'matching-undici')).toMatchObject({
            ok: true, dispatchedLength: '33',
        });
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);
