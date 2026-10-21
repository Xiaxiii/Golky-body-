module.exports = async () => { global.deviceId = 'test-device'; require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'anonymous_token'), 'anon'); };
