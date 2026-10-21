# 测试

不连网易云，只测本项目自己的代码：用 `fake-ncm/` 代替网易云接口包，在真实的 SillyTavern 1.19.0 里跑。

```bash
# 1. 准备 SillyTavern 1.19.0
git clone --depth 1 --branch 1.19.0 https://github.com/SillyTavern/SillyTavern.git st && cd st
npm ci --omit=dev
cp default/config.yaml config.yaml
sed -i 's/^enableServerPlugins: false/enableServerPlugins: true/; s/^enableServerPluginsAutoUpdate: true/enableServerPluginsAutoUpdate: false/; s/^enableUserAccounts: false/enableUserAccounts: true/; s/^whitelistMode: true/whitelistMode: false/; s/^port: 8000/port: 8123/' config.yaml

# 2. 装插件和扩展，用替身代替接口包
mkdir -p plugins/netease-player/node_modules/@neteasecloudmusicapienhanced
cp ../server/netease-player/* plugins/netease-player/
cp -r ../tests/fake-ncm plugins/netease-player/node_modules/@neteasecloudmusicapienhanced/api
cp -r ../extension/netease-player public/scripts/extensions/third-party/

# 3. 测试音频（3 秒正弦波），放在 8124 端口
mkdir -p /tmp/songs && (cd /tmp/songs && python3 /path/to/repo/tests/make-songs.py && python3 -m http.server 8124 &)

# 4. 启动酒馆，再跑测试
node server.js &
PLAYWRIGHT=/path/to/playwright node ../tests/e2e.cjs
```

覆盖：启动阶段的请求数、面板懒加载、搜索播放、Media Session metadata、生成状态（事件和 `data-generating` 备用信号）、
扫码登录流程、歌单播放全部、预取下一首后无静音直接切歌、取不到地址时跳过、暂停/继续/下一首、刷新后恢复队列并「继续播放」。

iOS 后台行为（锁屏连续播放、锁屏刷新 metadata、提示音是否打断）只能在 iPhone 上实测，见根目录 README 的测试清单。
