# 生成测试用的 3 秒 440Hz 音频：song1.wav、song11.wav ...
import math
import struct
import wave

for i in [1, 11, 12, 13, 14, 15, 99]:
    w = wave.open(f'song{i}.wav', 'wb')
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(8000)
    w.writeframes(b''.join(struct.pack('<h', int(3000 * math.sin(2 * math.pi * 440 * n / 8000))) for n in range(8000 * 3)))
    w.close()
