// 安装后在服务器上自检：node plugins/netease-player/selftest.mjs
// 不登录、不用手机 IP，只确认接口包能加载、服务器能连上网易云。
import { callNcm, getSongUrl, mapTrack } from './lib.mjs';

const keyword = process.argv[2] || '晴天 周杰伦';

try {
    const t0 = Date.now();
    const result = await callNcm('cloudsearch', { keywords: keyword, type: 1, limit: 3, offset: 0 });
    const songs = (result?.result?.songs || []).map(s => mapTrack(s));
    if (!songs.length) {
        console.log('SELFTEST FAIL: 搜索没有结果', JSON.stringify(result).slice(0, 300));
        process.exit(1);
    }
    console.log(`搜索 OK（${Date.now() - t0} ms）：${songs[0].name} - ${songs[0].ar}`);
    const url = await getSongUrl(String(songs[0].id), 'standard', {});
    if (url.url) {
        console.log(`取地址 OK：${Math.round(url.br / 1000)} kbps${url.trial ? '（试听片段，登录后可播完整版）' : ''}`);
    } else {
        console.log(`取地址：没拿到地址（code ${url.code}），未登录时部分歌曲取不到，属正常`);
    }
    console.log('SELFTEST OK');
    process.exit(0);
} catch (error) {
    console.log('SELFTEST FAIL:', error?.message || error);
    process.exit(1);
}
