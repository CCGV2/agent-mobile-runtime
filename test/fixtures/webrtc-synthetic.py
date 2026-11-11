"""Test-only media source; never selectable through runtime configuration/API."""
import asyncio
import math
from pathlib import Path
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "webrtc"))
import worker


class SyntheticSources:
    def __init__(self, args, authorization):
        self.closed = False

    async def images(self):
        import av
        counter = 0
        while not self.closed:
            frame = av.VideoFrame(320, 240, "yuv420p")
            for plane, value in zip(frame.planes, [80 + counter % 80, 96, 160]):
                plane.update(bytes([value]) * plane.buffer_size)
            counter += 1
            yield frame
            await asyncio.sleep(1/15)

    async def audio(self):
        offset = 0
        while not self.closed:
            values = []
            for sample in range(960):
                value = int(6000 * math.sin(2*math.pi*440*(offset+sample)/48000))
                values.extend([value, value])
            offset += 960
            yield struct.pack("<1920h", *values)
            await asyncio.sleep(.02)

    async def close(self):
        self.closed = True


worker.GrpcSources = SyntheticSources
raise SystemExit(worker.main())
