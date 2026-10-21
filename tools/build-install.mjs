// 生成可以直接粘贴进阿里云 Workbench 的安装命令：node tools/build-install.mjs
// 文件打包成 tar.gz + base64，切成不超过 CHUNK 字符的小段（Workbench 一次粘贴太长会被截断），
// 每段单独用 sha256 校验，最后一段校验所有分段后再解包。命令里只用 ASCII，避免中文被终端弄乱。
// 输出 INSTALL.md 和 install/steps.json。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ST = '/root/SillyTavern';
const PLUGIN_DIR = `${ST}/plugins/netease-player`;
const EXT_DIR = `${ST}/public/scripts/extensions/third-party/netease-player`;
const CHUNK = 4500;
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/netease-player/package.json'), 'utf8')).version;

function pack(dir, files) {
    const tar = execFileSync('tar', [
        '--sort=name', '--mtime=2026-01-01 00:00Z', '--owner=0', '--group=0', '--numeric-owner',
        '-cf', '-', '-C', path.join(ROOT, dir), ...files,
    ]);
    const gz = execFileSync('gzip', ['-9n'], { input: tar });
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    const lines = gz.toString('base64').match(/.{1,76}/g);
    const perChunk = Math.floor(CHUNK / 77);
    const chunks = [];
    for (let i = 0; i < lines.length; i += perChunk) {
        const text = lines.slice(i, i + perChunk).join('\n') + '\n';
        chunks.push({ text, sha: crypto.createHash('sha256').update(text).digest('hex') });
    }
    return { sha, chunks };
}

/** 一个包切成几段粘贴命令；最后一段把所有分段校验一遍再解包。 */
function chunkSteps(name, label, dest, packed, files) {
    const n = packed.chunks.length;
    const part = (i) => `/tmp/nep/${name}.${i + 1}`;
    const NAME = name.toUpperCase();
    return packed.chunks.map((c, i) => {
        const lines = [
            `mkdir -p /tmp/nep && cat > ${part(i)} <<'NEP_EOF'`,
            c.text + 'NEP_EOF',
            `echo "${c.sha}  ${part(i)}" | sha256sum -c --quiet >/dev/null 2>&1 && echo "${name} ${i + 1}/${n} OK" || echo "${name} ${i + 1}/${n} FAIL: paste this block again"`,
        ];
        if (i === n - 1) {
            const sums = packed.chunks.map((cc, j) => `${cc.sha}  ${part(j)}`).join('\\n');
            lines.push(
                `if printf '${sums}\\n' | sha256sum -c --quiet >/dev/null 2>&1; then cat ${packed.chunks.map((_, j) => part(j)).join(' ')} | base64 -d > /tmp/nep/${name}.tgz && echo "${packed.sha}  /tmp/nep/${name}.tgz" | sha256sum -c --quiet >/dev/null && mkdir -p ${dest} && tar xzf /tmp/nep/${name}.tgz -C ${dest} && ls ${files.map(f => `${dest}/${f}`).join(' ')} >/dev/null && rm -f /tmp/nep/${name}.* && echo "${NAME} OK" || echo "${NAME} FAIL: unpack error"; else printf '${sums}\\n' | sha256sum -c 2>/dev/null | grep -v ': OK$' | sed 's#^#  bad or missing: #'; echo "${NAME} NOT READY: re-paste the parts listed above, then this block"; fi`,
            );
        }
        return {
            id: `${name}${i + 1}`,
            title: `${label}（第 ${i + 1}/${n} 段）`,
            note: i === n - 1
                ? `最后应看到 ${name} ${i + 1}/${n} OK 和 ${NAME} OK。如果列出某段 bad or missing，把那一段重新粘贴，再粘贴这一段。`
                : `应看到 ${name} ${i + 1}/${n} OK。看到 FAIL 就把这一段重新复制粘贴。`,
            cmd: lines.join('\n'),
        };
    });
}

const SERVER_FILES = ['package.json', 'index.mjs', 'lib.mjs', 'selftest.mjs'];
const EXT_FILES = ['manifest.json', 'index.js', 'engine.js', 'panel.js'];
const server = pack('server/netease-player', SERVER_FILES);
const ext = pack('extension/netease-player', EXT_FILES);

const steps = [
    {
        id: 'check',
        title: '第 1 步：检查环境',
        note: '确认酒馆目录、Node 版本、服务端插件开关和 pm2。最后一行应是 STEP1 OK。',
        cmd: `cd ${ST} && node -v && grep -qE '^enableServerPlugins: *true' config.yaml && pm2 -v >/dev/null && echo "STEP1 OK" || echo "STEP1 FAIL: check SillyTavern dir, enableServerPlugins in config.yaml, pm2"`,
    },
    ...chunkSteps('server', '第 2 步：写入服务端插件', PLUGIN_DIR, server, SERVER_FILES),
    {
        id: 'npm',
        title: '第 3 步：安装网易云接口依赖（约 1～3 分钟）',
        note: '在后台安装，终端断开也会继续。等待时每 5 秒打一个点。最后一行应是 STEP3 OK。如果中途断开，重新连上后再粘贴一次这段即可（正在装就接着等，装失败了会重装）。',
        cmd: [
            `cd ${PLUGIN_DIR} && P=/root/nep-npm.pid && if [ ! -f node_modules/@neteasecloudmusicapienhanced/api/main.js ] && ! { [ -f $P ] && kill -0 "$(cat $P)" 2>/dev/null; }; then`,
            `  nohup sh -c 'A="--omit=dev --ignore-scripts --no-audit --no-fund"; npm install $A --registry=https://registry.npmmirror.com || { echo "mirror failed, trying default registry"; npm install $A; }; echo "EXIT $?"' > /root/nep-npm.log 2>&1 & echo $! > $P`,
            'fi',
            'for i in $(seq 1 72); do grep -q "^EXIT" /root/nep-npm.log 2>/dev/null && break; [ -f $P ] && kill -0 "$(cat $P)" 2>/dev/null || break; sleep 5; printf "."; done; echo',
            'tail -n 3 /root/nep-npm.log 2>/dev/null; [ -f node_modules/@neteasecloudmusicapienhanced/api/main.js ] && ! grep -q "^EXIT [1-9]" /root/nep-npm.log 2>/dev/null && echo "STEP3 OK" || echo "STEP3 NOT READY: send the lines above to the developer"',
        ].join('\n'),
    },
    {
        id: 'selftest',
        title: '第 4 步：自检（服务器能不能连上网易云）',
        note: '应看到「搜索 OK」和 SELFTEST OK。如果提示 460：这是网易云拦了服务器自己的 IP，实际使用时会带上手机的 IP，可以先继续往下装，到手机上再看能不能搜歌。',
        cmd: `cd ${ST} && timeout 90 node plugins/netease-player/selftest.mjs`,
    },
    ...chunkSteps('ext', '第 5 步：写入前端扩展', EXT_DIR, ext, EXT_FILES),
    {
        id: 'restart',
        title: '第 6 步：重启酒馆',
        note: '会等酒馆启动完（最多 2 分钟）。应看到「[netease-player] loaded」和 STEP6 OK。然后在 iPhone 上刷新酒馆页面。',
        cmd: [
            // 只看这次重启之后新写的日志
            `L=$(pm2 jlist | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=a.find(x=>x.name==="start");console.log(p.pm2_env.pm_out_log_path+" "+p.pm2_env.pm_err_log_path)') && set -- $L && O=$(stat -c %s $1) && E=$(stat -c %s $2)`,
            'pm2 restart start >/dev/null && for i in $(seq 1 40); do sleep 3; tail -c +$((O+1)) $1 | grep -q "netease-player\\] loaded" && break; printf "."; done; echo',
            '{ tail -c +$((O+1)) $1; tail -c +$((E+1)) $2; } | grep -E "netease-player|Failed to load plugin" | tail -n 5',
            'tail -c +$((O+1)) $1 | grep -q "netease-player\\] loaded" && echo "STEP6 OK" || echo "STEP6 NOT LOADED: send the lines above to the developer"',
        ].join('\n'),
    },
];

const uninstall = {
    id: 'uninstall',
    title: '卸载（一条命令）',
    note: '删除服务端插件（含网易云登录数据）、前端扩展和安装日志，然后重启酒馆。iPhone 上残留的播放记录不影响使用。',
    cmd: `rm -rf ${PLUGIN_DIR} ${EXT_DIR} /root/nep-npm.log /root/nep-npm.pid /tmp/nep && pm2 restart start >/dev/null && echo "UNINSTALL OK"`,
};

const status = {
    id: 'status',
    title: '不确定装到哪一步了：检查进度',
    note: '每行 have 表示已装好，MISSING 表示还没装好，从对应的那一步接着做。',
    cmd: `cd ${ST} && for f in ${[...SERVER_FILES.map(f => `plugins/netease-player/${f}`), 'plugins/netease-player/node_modules/@neteasecloudmusicapienhanced/api/main.js', ...EXT_FILES.map(f => `public/scripts/extensions/third-party/netease-player/${f}`)].join(' ')}; do [ -f $f ] && echo "have    $f" || echo "MISSING $f"; done`,
};

const logs = {
    id: 'logs',
    title: '出问题时：查看插件日志',
    note: '把输出发给开发者。',
    cmd: 'pm2 logs start --lines 400 --nostream 2>&1 | grep -E "netease-player|\\[ERR\\]" | tail -n 30',
};

fs.mkdirSync(path.join(ROOT, 'install'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'install/steps.json'), JSON.stringify({ version: VERSION, steps, extra: [status, logs, uninstall] }, null, 2));

const md = [
    `# 安装命令（v${VERSION}）`,
    '',
    '> 本文件由 `node tools/build-install.mjs` 生成，不要手改。',
    '> 在阿里云 Workbench 的 **Shell** 模式里（不要用 Agent 模式），每一段**整段复制、粘贴、回车**，看到 OK 再做下一段。',
    '> 文件内容切成了几小段（base64），每段都有校验：粘贴不完整会提示 FAIL，不会写坏文件。',
    '',
    ...[...steps, status, logs, uninstall].flatMap(s => [`## ${s.title}`, '', s.note, '', '```bash', s.cmd, '```', '']),
    '## 以后升级',
    '',
    '重新执行第 2、5、6 步即可（第 3 步只有依赖版本变了才需要）。登录状态会保留。',
    '',
];
fs.writeFileSync(path.join(ROOT, 'INSTALL.md'), md.join('\n'));
console.log(`INSTALL.md / install/steps.json 已生成：server ${server.chunks.length} 段, ext ${ext.chunks.length} 段, 最长一段 ${Math.max(...steps.map(s => s.cmd.length))} 字符`);
