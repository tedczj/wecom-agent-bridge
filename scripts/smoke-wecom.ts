/** Explicit live echo/media probe; never starts an Agent. */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig, preparePaths } from '../src/config.ts';
import { configArg } from '../src/main.ts';
import { acquireLock } from '../src/fsutil.ts';
import { createWecom, normalize } from '../src/wecom.ts';
import { MediaStore } from '../src/media.ts';
import { deadline } from '../src/async.ts';
import { errorCode, invariant } from '../src/errors.ts';
try {
    const args = process.argv.slice(2);
    invariant(args.includes('--live'), 'EXPLICIT_LIVE_FLAG_REQUIRED');
    const c = loadConfig(configArg(args));
    preparePaths(c);
    process.umask(0o077);
    const index = args.indexOf('--delay-seconds');
    const delay = index < 0 ? 360 : Number(args[index + 1]);
    invariant(Number.isInteger(delay) && delay >= 0 && delay <= 3600, 'DELAY_INVALID');
    const { channel, botId } = createWecom(c);
    const media = new MediaStore(c);
    const unlock = acquireLock(c.stateRoot);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const seen = new Set<string>();
    const controllers = new Set<AbortController>();
    const close = () => { channel.disconnect(); for (const timer of timers)
        clearTimeout(timer); for (const controller of controllers)
        controller.abort(); unlock(); };
    process.once('SIGTERM', () => { close(); process.exit(0); });
    process.once('SIGINT', () => { close(); process.exit(0); });
    channel.connect(async (frame) => {
        let controller: AbortController | undefined;
        try {
            const message = normalize(frame, c, botId);
            if (seen.has(message.messageId))
                return;
            seen.add(message.messageId);
            if (seen.size > 1000)
                seen.delete(seen.values().next().value!);
            invariant(!message.unsupported, 'UNSUPPORTED_MESSAGE');
            controller = new AbortController();
            controllers.add(controller);
            const id = randomUUID();
            void deadline(channel.receipt(message.reqId, 'smoke 已接收，正在检查输入。'), c.reply.sendTimeoutMs, 'SEND_TIMEOUT').catch(() => console.log(JSON.stringify({ phase: 'receipt', status: 'unknown' })));
            const images = await media.prepare(id, message.media, controller.signal);
            if (images.length) {
                const manifest = `smoke-${id}.json`;
                writeFileSync(path.join(c.stateRoot, manifest), JSON.stringify(images, null, 2), { mode: 0o600 });
                console.log(JSON.stringify({ phase: 'media', status: 'saved', manifest, images: images.map(i => ({ sha256: i.sha256, bytes: i.bytes, mimeType: i.mimeType })) }));
            }
            await deadline(channel.send(message.route, `smoke：已收到 ${images.length} 张图片；未调用 Agent。${delay} 秒后测试主动发送。`), c.reply.sendTimeoutMs, 'SEND_TIMEOUT');
            const timer = setTimeout(() => { timers.delete(timer); void deadline(channel.send(message.route, `smoke：延迟 ${delay} 秒主动发送测试完成；未调用 Agent。`), c.reply.sendTimeoutMs, 'SEND_TIMEOUT').then(() => console.log(JSON.stringify({ phase: 'delayed-send', delay, status: 'acknowledged' }))).catch(e => console.log(JSON.stringify({ phase: 'delayed-send', status: 'unknown', code: errorCode(e) }))); }, delay * 1000);
            timers.add(timer);
            console.log(JSON.stringify({ phase: 'active-send', status: 'acknowledged' }));
        }
        catch (e) {
            console.log(JSON.stringify({ phase: 'message', code: errorCode(e) }));
        }
        finally {
            if (controller)
                controllers.delete(controller);
        }
    }, () => console.log(JSON.stringify({ phase: 'authenticated', status: true })));
    console.log(JSON.stringify({ mode: 'wecom-live-smoke', agentStarted: false, delaySeconds: delay, notice: '仅允许名单；Ctrl-C 结束后才可启动正式 bridge。' }));
}
catch (e) {
    console.error(JSON.stringify({ code: errorCode(e) }));
    process.exitCode = 1;
}
