/** Explicit live model probe. It uses a separate native session and no WeCom connection. */
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadConfig, preparePaths } from '../src/config.ts';
import { configArg } from '../src/main.ts';
import { acquireLock, readControlled } from '../src/fsutil.ts';
import { MediaStore } from '../src/media.ts';
import { PiBackend } from '../src/pi.ts';
import type { NormalizedInput, SessionRef, ImageRef } from '../src/types.ts';
import { errorCode, invariant } from '../src/errors.ts';
try {
    const args = process.argv.slice(2);
    invariant(args.includes('--live'), 'EXPLICIT_LIVE_FLAG_REQUIRED');
    const c = loadConfig(configArg(args));
    preparePaths(c);
    process.umask(0o077);
    invariant(c.agent.isolation === 'external' && c.agent.env.HOME, 'WORKSPACE_ISOLATION_UNVERIFIED');
    const media = new MediaStore(c);
    const backend = new PiBackend(c, image => media.read(image));
    const unlock = acquireLock(c.stateRoot);
    const shutdown = new AbortController();
    const onSignal = () => shutdown.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let current: SessionRef | undefined;
    const hooks = { persistSession: async (ref: SessionRef) => { current = { ...ref }; }, progress: () => { } };
    const nonce = randomBytes(8).toString('hex');
    const make = (text: string, images: ImageRef[] = []): NormalizedInput => ({ taskId: randomUUID(), messageId: randomUUID(), route: { botId: 'local-smoke', kind: 'single', targetId: 'operator', senderId: 'operator' }, receivedAt: Date.now(), text, images, workspaceId: c.workspace.id, sessionKey: 'local-smoke-' + nonce, generation: 0 });
    try {
        const run = async (i: NormalizedInput) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), c.agent.taskTimeoutMs);
            try {
                return await backend.run(i, current, hooks, AbortSignal.any([controller.signal, shutdown.signal]));
            }
            finally {
                clearTimeout(timer);
            }
        };
        const first = await run(make(`这是连通性测试。记住随机标记 ${nonce}，只回复“已记住”，不要调用工具或修改文件。`));
        invariant(first.outcome === 'success', 'SMOKE_FIRST_TURN_FAILED');
        const second = await run(make('只回复上轮的随机标记，不要调用工具或读取文件。'));
        invariant(second.outcome === 'success' && second.finalText.includes(nonce), 'SMOKE_SESSION_RESTORE_FAILED');
        console.log(JSON.stringify({ phase: 'text-and-session', status: 'passed', agentSettledObserved: backend.settledSeen }));
        const imageIndex = args.indexOf('--image-manifest');
        if (imageIndex >= 0) {
            invariant(args[imageIndex + 1], 'MANIFEST_ARGUMENT_REQUIRED');
            const parsed: unknown = JSON.parse((await readControlled(c.stateRoot, path.resolve(args[imageIndex + 1]!), 65536)).toString());
            invariant(Array.isArray(parsed) && parsed.length > 0 && parsed.length <= c.media.maxImages, 'MANIFEST_INVALID');
            const images = parsed as ImageRef[];
            await media.validate(images);
            const result = await run(make('请描述图片中的内容，包括可见文字和空间关系。不要调用工具或读取其他文件。', images));
            invariant(result.outcome === 'success', 'SMOKE_VISION_TURN_FAILED');
            const answerFile = path.join(c.stateRoot, `smoke-vision-${randomUUID()}.txt`);
            writeFileSync(answerFile, result.finalText, { mode: 0o600 });
            console.log(JSON.stringify({ phase: 'native-image', imageBytesSent: backend.imageBytesSent, status: 'manual-review-required', answerFile, notice: '必须人工比对图片与回答，不能仅据 API 成功认定模型看图正确。' }));
        }
        else
            console.log(JSON.stringify({ phase: 'native-image', status: 'unverified', notice: '先运行 smoke:wecom 保存图片 manifest，再用 --image-manifest 指定。' }));
    }
    finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        await backend.stop();
        unlock();
    }
}
catch (e) {
    console.error(JSON.stringify({ code: errorCode(e) }));
    process.exitCode = 1;
}
