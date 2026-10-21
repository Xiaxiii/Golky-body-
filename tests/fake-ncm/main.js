// 测试替身：代替 @neteasecloudmusicapienhanced/api，返回固定数据。歌曲地址指向 127.0.0.1:8124 上的测试音频。
const calls = [];
global.__nepCalls = calls;
const song = (id, name, fee = 0) => ({ id, name, ar: [{ name: '歌手' + id }], al: { name: '专辑', picUrl: 'http://p1.music.126.net/x.jpg' }, dt: 200000, fee, privilege: { st: 0, pl: fee ? 0 : 320000 } });
const rec = (name) => (q) => { calls.push({ name, q }); require('fs').appendFileSync(process.env.NEP_CALLS || '/dev/null', JSON.stringify({ name, realIP: q.realIP, cookie: q.cookie, key: q.key }) + '\n'); };
let qrChecks = 0;
// 歌单版本：测试往 NEP_FAKE_STATE 文件里写 1/2/3，「我喜欢的音乐」就有 3/4/5 首，模拟在网易云 App 里加了歌
const plVersion = () => { try { return Number(require('fs').readFileSync(process.env.NEP_FAKE_STATE || '', 'utf8').trim()) || 1; } catch { return 1; } };
const plSongs = () => [song(11, 'A'), song(12, 'B'), song(13, 'C'), song(14, 'D'), song(15, 'E')].slice(0, 2 + plVersion());
module.exports = {
  cloudsearch: async (q) => { rec('cloudsearch')(q); return { body: { code: 200, result: { songCount: 2, songs: [song(1, '晴天'), song(2, 'VIP歌', 1)] } } }; },
  login_qr_key: async (q) => { rec('login_qr_key')(q); return { body: { code: 200, data: { unikey: 'abc-123' } } }; },
  login_qr_create: async (q) => { rec('login_qr_create')(q); return { body: { code: 200, data: { qrurl: 'https://music.163.com/login?codekey=' + q.key, qrimg: 'data:image/png;base64,iVBORw0KGgo=' } } }; },
  login_qr_check: async (q) => { rec('login_qr_check')(q); qrChecks++; if (qrChecks < 2) return { body: { code: 801, message: '等待扫码' } }; return { body: { code: 803, message: '授权登陆成功', cookie: 'MUSIC_U=secretU; Max-Age=1296000; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Path=/;__csrf=csrf1; Path=/; HTTPOnly' } }; },
  login_status: async (q) => { rec('login_status')(q); return q.cookie && q.cookie.MUSIC_U ? { body: { data: { code: 200, account: { vipType: 11 }, profile: { userId: 99, nickname: '测试用户', avatarUrl: '' } } } } : { body: { data: { code: 200, account: null, profile: null } } }; },
  logout: async (q) => { rec('logout')(q); return { body: { code: 200 } }; },
  user_playlist: async (q) => { rec('user_playlist')(q); return { body: { playlist: [{ id: 500, name: '我喜欢的音乐', coverImgUrl: '', trackCount: plSongs().length, trackUpdateTime: 1700000000000 + plVersion(), specialType: 5, creator: { userId: 99 } }] } }; },
  playlist_track_all: async (q) => { rec('playlist_track_all')(q); const off = Number(q.offset); const s = plSongs().slice(off, off + Number(q.limit)); return { body: { songs: s, privileges: s.map(x => ({ id: x.id, st: 0, pl: 1 })) } }; },
  song_url_v1: async (q) => { rec('song_url_v1')(q); if (q.id === '2') return { body: { data: [{ id: 2, url: null, code: 404 }] } }; if (q.id === '13') throw { status: 460, body: { code: 460, msg: 'Cheating' } }; return { body: { data: [{ id: Number(q.id), url: 'http://127.0.0.1:8124/song' + q.id + '.wav', br: 128000, expi: 1200, freeTrialInfo: null }] } }; },
  song_url: async (q) => { rec('song_url')(q); throw { status: 460, body: { code: 460, msg: 'Cheating' } }; },
};
