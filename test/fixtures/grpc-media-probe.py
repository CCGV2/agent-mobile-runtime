#!/usr/bin/env python3
"""SDK acceptance probe; credentials arrive only over private stdin."""
import asyncio
import json
import re
import struct
import math
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'webrtc'))
import worker

async def main(value):
    import grpc
    from google.protobuf.empty_pb2 import Empty
    pb, rpc = worker.load_protos(value['protoDir'])
    channel = grpc.aio.secure_channel(worker.validate_endpoint(value['address']), grpc.local_channel_credentials(grpc.LocalConnectionType.LOCAL_TCP))
    stub = rpc.EmulatorControllerStub(channel)
    image = pb.ImageFormat(format=pb.ImageFormat.PNG, width=720, height=1280, display=0)
    audio = pb.AudioFormat(samplingRate=48000, channels=pb.AudioFormat.Stereo, format=pb.AudioFormat.AUD_FMT_S16)
    result = {}
    try:
        for name, request, credential, allowed in [
            ('streamScreenshot', image, None, False), ('streamAudio', audio, None, False),
            ('streamAudio', audio, value['headers']['screen'], False),
            ('streamScreenshot', image, value['headers']['screen'], True),
            ('streamAudio', audio, value['headers']['audio'], True),
        ]:
            tag = name + (':anonymous' if credential is None else ':correct' if allowed else ':wrong-audience')
            call = getattr(stub, name)(request, metadata=[] if credential is None else [('authorization', credential)], timeout=7)
            try:
                message = await call.read()
                if not allowed:
                    raise RuntimeError('Unauthorized stream unexpectedly accepted')
                if name == 'streamScreenshot':
                    result[tag] = {'bytes': len(message.image), 'png': message.image[:8] == b'\x89PNG\r\n\x1a\n', 'width': message.format.width, 'height': message.format.height}
                else:
                    data = bytearray(message.audio)
                    while len(data) < 192000:
                        next_message = await call.read()
                        if next_message is grpc.aio.EOF:
                            break
                        data.extend(next_message.audio)
                    samples = struct.unpack('<' + 'h' * (len(data) // 2), data)
                    result[tag] = {'bytes': len(data), 'rate': message.format.samplingRate, 'channels': message.format.channels, 'encoding': message.format.format,
                                   'rms': math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples))),
                                   'peak': max((abs(sample) for sample in samples), default=0)}
            except grpc.aio.AioRpcError as error:
                detail = re.sub(r'[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted-token]', error.details() or '')[:400]
                result[tag] = {'status': error.code().name, 'reason': detail}
                if allowed or error.code() not in (grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED):
                    result['ok'] = False
            finally:
                call.cancel()
        try:
            await stub.getStatus(Empty(), metadata=[('authorization', value['headers']['screen'])], timeout=3)
            result['getStatus'] = 'UNEXPECTED_ALLOWED'; result['ok'] = False
        except grpc.aio.AioRpcError as error:
            result['getStatus'] = error.code().name
            if error.code() not in (grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED): result['ok'] = False
    finally:
        await channel.close()
    result.setdefault('ok', True)
    print(json.dumps(result), flush=True)
    return result['ok']

try:
    value = json.loads(sys.stdin.buffer.readline(32768))
    raise SystemExit(0 if asyncio.run(main(value)) else 1)
except SystemExit:
    raise
except Exception:
    print(json.dumps({'ok': False, 'error': 'SDK media probe failed'}), flush=True)
    raise SystemExit(1)
