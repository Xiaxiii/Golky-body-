// SillyTavern 服务端插件：给页面内的网易云播放器提供接口。
// 路由挂在 /api/plugins/netease-player/ 下，位于酒馆的登录验证和 CSRF 校验之后；
// 全部使用 POST，这样每个请求都要带酒馆的 CSRF token。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callNcm, getSongUrl, mapTrack, parseCookieString, LEVELS } from './lib.mjs';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(PLUGIN_DIR, 'data');

export const info = {
    id: 'netease-player',
    name: 'NetEase Player',
    description: 'NetEase Cloud Music search, playlists, play URLs and QR login for the in-page player.',
};

// ---------- 登录 cookie：只存在服务器本地，按酒馆用户分开 ----------

function userHandle(req) {
    const handle = String(req.user?.profile?.handle || 'default-user');
    return handle.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default-user';
}

function cookiePath(req) {
    return path.join(DATA_DIR, `cookie-${userHandle(req)}.json`);
}

function readCookie(req) {
    try {
        const data = JSON.parse(fs.readFileSync(cookiePath(req), 'utf8'));
        return data && typeof data === 'object' && data.MUSIC_U ? data : null;
    } catch {
        return null;
    }
}

function writeCookie(req, cookie) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DATA_DIR, 0o700);
    const file = cookiePath(req);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cookie), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

function deleteCookie(req) {
    fs.rmSync(cookiePath(req), { force: true });
}

// ---------- 手机的 IP：作为 realIP 传给网易云，避免服务器 IP 被拦 ----------

function normalizeIp(ip) {
    ip = String(ip || '').trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
}

function isLocalIp(ip) {
    return !ip
        || ip === '::1'
        || /^127\./.test(ip)
        || /^10\./.test(ip)
        || /^192\.168\./.test(ip)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
        || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
        || /^f[cd]/i.test(ip)
        || /^fe80:/i.test(ip);
}

function clientIp(req) {
    const socketIp = normalizeIp(req.socket?.remoteAddress);
    if (!isLocalIp(socketIp)) {
        return socketIp;
    }
    // 前面有反向代理时，才看转发头
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(normalizeIp).find(ip => !isLocalIp(ip));
    const realIp = normalizeIp(req.headers['x-real-ip']);
    return forwarded || (!isLocalIp(realIp) ? realIp : undefined);
}

function ctxOf(req, { auth = true } = {}) {
    return {
        cookie: auth ? (readCookie(req) || {}) : {},
        realIP: clientIp(req),
    };
}

// ---------- 短时缓存（歌单类数据），播放地址不缓存 ----------

const cache = new Map();
const CACHE_MAX = 200;

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
        cache.delete(key);
        return undefined;
    }
    return hit.value;
}

function cacheSet(key, value, ttlMs) {
    if (cache.size >= CACHE_MAX) {
        cache.delete(cache.keys().next().value);
    }
    cache.set(key, { value, expires: Date.now() + ttlMs });
}

function cacheClearUser(req) {
    const prefix = `${userHandle(req)}:`;
    for (const key of [...cache.keys()]) {
        if (key.startsWith(prefix)) cache.delete(key);
    }
}

// ---------- 路由 ----------

function route(router, url, handler) {
    router.post(url, async (req, res) => {
        try {
            const result = await handler(req, req.body || {});
            res.json({ ok: true, ...result });
        } catch (error) {
            const code = error?.code;
            if (code !== 301) {
                console.warn(`[netease-player] ${url} 失败：`, error?.message || error);
            }
            // 业务错误用 200 返回，避免其他扩展对 4xx/5xx 做额外处理
            res.json({ ok: false, error: error?.message || String(error), code: code ?? null, needLogin: code === 301 });
        }
    });
}

function badRequest(message) {
    const error = new Error(message);
    error.code = 400;
    return error;
}

function needLogin() {
    const error = new Error('需要先扫码登录网易云');
    error.code = 301;
    return error;
}

function toInt(value, def, min, max) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

function toId(value) {
    const s = String(value ?? '');
    if (!/^\d{1,20}$/.test(s)) throw badRequest('id 不正确');
    return s;
}

async function fetchAccount(req) {
    if (!readCookie(req)) return null;
    const key = `${userHandle(req)}:account`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const body = await callNcm('login_status', {}, ctxOf(req));
    const data = body?.data || body || {};
    const profile = data.profile;
    if (!profile) {
        return null;
    }
    const account = {
        uid: profile.userId,
        nickname: profile.nickname || '',
        avatar: profile.avatarUrl || '',
        vipType: data.account?.vipType ?? profile.vipType ?? 0,
    };
    cacheSet(key, account, 10 * 60 * 1000);
    return account;
}

export async function init(router) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

    route(router, '/status', async (req) => {
        const account = await fetchAccount(req);
        return account ? { loggedIn: true, ...account } : { loggedIn: false };
    });

    route(router, '/qr/start', async (req) => {
        const keyBody = await callNcm('login_qr_key', {}, ctxOf(req, { auth: false }));
        const key = keyBody?.data?.unikey;
        if (!key) throw new Error('没拿到登录二维码，请稍后再试');
        const qrBody = await callNcm('login_qr_create', { key, qrimg: true }, ctxOf(req, { auth: false }));
        return { key, qrurl: qrBody?.data?.qrurl || '', qrimg: qrBody?.data?.qrimg || '' };
    });

    route(router, '/qr/check', async (req, body) => {
        const key = String(body.key || '');
        if (!/^[\w-]{1,64}$/.test(key)) throw badRequest('key 不正确');
        const result = await callNcm('login_qr_check', { key }, ctxOf(req, { auth: false }));
        const code = Number(result?.code) || 0;
        if (code === 803) {
            const cookie = parseCookieString(result.cookie);
            if (!cookie.MUSIC_U) throw new Error('登录成功但没拿到登录凭据，请重试');
            writeCookie(req, cookie);
            cacheClearUser(req);
        }
        // 只返回状态码和提示，不返回 cookie
        return { status: code, message: result?.message || '' };
    });

    route(router, '/logout', async (req) => {
        if (readCookie(req)) {
            try {
                await callNcm('logout', {}, ctxOf(req));
            } catch {
                // 网易云那边退出失败不影响本地删除
            }
        }
        deleteCookie(req);
        cacheClearUser(req);
        return {};
    });

    route(router, '/search', async (req, body) => {
        const keywords = String(body.keywords || '').trim().slice(0, 100);
        if (!keywords) throw badRequest('请输入关键词');
        const limit = toInt(body.limit, 30, 1, 100);
        const offset = toInt(body.offset, 0, 0, 2000);
        const result = await callNcm('cloudsearch', { keywords, type: 1, limit, offset }, ctxOf(req));
        const songs = result?.result?.songs || [];
        const total = result?.result?.songCount || 0;
        return { tracks: songs.map(s => mapTrack(s)), total, hasMore: offset + songs.length < total };
    });

    route(router, '/playlists', async (req) => {
        const account = await fetchAccount(req);
        if (!account) throw needLogin();
        const key = `${userHandle(req)}:playlists`;
        let list = cacheGet(key);
        if (!list) {
            const result = await callNcm('user_playlist', { uid: account.uid, limit: 200, offset: 0 }, ctxOf(req));
            list = (result?.playlist || []).map(p => ({
                id: p.id,
                name: p.name || '',
                cover: p.coverImgUrl || '',
                count: p.trackCount || 0,
                liked: p.specialType === 5,
                mine: p.creator?.userId === account.uid,
            }));
            cacheSet(key, list, 2 * 60 * 1000);
        }
        return { playlists: list };
    });

    route(router, '/playlist/tracks', async (req, body) => {
        const id = toId(body.id);
        const limit = toInt(body.limit, 200, 1, 500);
        const offset = toInt(body.offset, 0, 0, 100000);
        const key = `${userHandle(req)}:pl:${id}:${offset}:${limit}`;
        let page = cacheGet(key);
        if (!page) {
            const result = await callNcm('playlist_track_all', { id, limit, offset }, ctxOf(req));
            const privileges = new Map((result?.privileges || []).map(p => [p.id, p]));
            const songs = result?.songs || [];
            page = { tracks: songs.map(s => mapTrack(s, privileges.get(s.id))), hasMore: songs.length >= limit };
            cacheSet(key, page, 5 * 60 * 1000);
        }
        return page;
    });

    route(router, '/url', async (req, body) => {
        const id = toId(body.id);
        const level = LEVELS.includes(body.level) ? body.level : 'standard';
        return await getSongUrl(id, level, ctxOf(req));
    });

    console.log('[netease-player] 已加载，接口包会在第一次使用时才载入。');
}

export async function exit() {
    cache.clear();
}

export default { info, init, exit };
