// 网易云接口封装：懒加载 @neteasecloudmusicapienhanced/api，只在第一次真正用到时才 require。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PKG = '@neteasecloudmusicapienhanced/api';

let ncm = null;
let initPromise = null;

function anonymousTokenReady() {
    try {
        return fs.readFileSync(path.join(os.tmpdir(), 'anonymous_token'), 'utf8').trim().length > 0;
    } catch {
        return false;
    }
}

/**
 * 加载接口包并完成一次初始化（游客 token、加密公钥）。
 * 初始化里的错误由接口包自己打印，这里只保证不会重复初始化。
 */
export async function getNcm() {
    if (!ncm) {
        ncm = require(PKG);
    }
    if (!initPromise) {
        initPromise = (async () => {
            const generateConfig = require(`${PKG}/generateConfig.js`);
            await generateConfig();
            // 首次运行时游客注册早于公钥获取，会失败一次；公钥拿到后再来一遍即可。
            if (!global.deviceId || !anonymousTokenReady()) {
                await generateConfig();
            }
        })().catch((error) => {
            console.warn('[netease-player] 初始化失败，下次请求时重试：', error?.message || error);
            initPromise = null;
        });
    }
    await initPromise;
    return ncm;
}

export class NcmError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

function describeFailure(error) {
    const body = error?.body ?? {};
    const code = Number(body.code ?? error?.status ?? 0) || 0;
    let message = body.message || body.msg || error?.message || '未知错误';
    if (typeof message !== 'string') {
        message = String(message);
    }
    if (code === 460) {
        message = '网易云拦截了这次请求（460），稍后再试';
    } else if (code === 301) {
        message = '网易云登录已失效，请重新扫码登录。';
    } else if (code === 502 && /timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) {
        message = `连不上网易云服务器：${message}`;
    }
    return new NcmError(message, code);
}

/**
 * 调用一个接口模块。
 * @param {string} name 模块名，例如 'cloudsearch'
 * @param {object} params 参数
 * @param {{cookie?: object, realIP?: string}} ctx
 */
export async function callNcm(name, params, ctx = {}) {
    const api = await getNcm();
    const fn = api[name];
    if (typeof fn !== 'function') {
        throw new NcmError(`接口包里没有 ${name}，可能是版本不对`, 500);
    }
    const query = { ...params, cookie: ctx.cookie || {}, timestamp: Date.now() };
    if (ctx.realIP) {
        query.realIP = ctx.realIP;
    }
    try {
        const res = await fn(query);
        return res?.body ?? {};
    } catch (error) {
        throw describeFailure(error);
    }
}

const COOKIE_ATTRS = new Set(['path', 'domain', 'expires', 'max-age', 'httponly', 'secure', 'samesite']);

/** 把登录返回的 Set-Cookie 串（用 ; 拼接）解析成 {名: 值}，去掉 Path/Expires 这类属性。 */
export function parseCookieString(str) {
    const out = {};
    for (const part of String(str || '').split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const key = part.slice(0, i).trim();
        if (!key || COOKIE_ATTRS.has(key.toLowerCase())) continue;
        out[key] = part.slice(i + 1).trim();
    }
    return out;
}

function artists(list) {
    return (Array.isArray(list) ? list : []).map(a => a?.name).filter(Boolean).join(' / ');
}

/** 把网易云的歌曲对象压缩成前端需要的几个字段。 */
export function mapTrack(song, privilege) {
    const p = privilege || song.privilege || {};
    const album = song.al || song.album || {};
    return {
        id: song.id,
        name: song.name || '',
        ar: artists(song.ar || song.artists),
        al: album.name || '',
        pic: album.picUrl || '',
        dt: song.dt || song.duration || 0,
        fee: song.fee ?? p.fee ?? 0,
        st: p.st ?? 0,
        pl: p.pl ?? null,
    };
}

export const LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires'];

/** 取播放地址；新接口失败时退回旧接口。 */
export async function getSongUrl(id, level, ctx) {
    let item = null;
    try {
        const body = await callNcm('song_url_v1', { id, level }, ctx);
        item = body?.data?.[0] ?? null;
    } catch (error) {
        if (error.code === 301) throw error;
        const brMap = { standard: 128000, higher: 192000, exhigh: 320000 };
        const body = await callNcm('song_url', { id, br: brMap[level] || 999000 }, ctx);
        item = body?.data?.[0] ?? null;
    }
    if (!item) {
        return { url: null, code: 404 };
    }
    return {
        url: item.url || null,
        br: item.br || 0,
        size: item.size || 0,
        type: item.type || '',
        level: item.level || level,
        expi: item.expi || 1200,
        trial: !!item.freeTrialInfo,
        fee: item.fee ?? 0,
        code: item.code ?? 200,
    };
}
