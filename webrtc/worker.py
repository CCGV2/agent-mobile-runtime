#!/usr/bin/env python3
"""One outgoing-media WebRTC peer. Private NDJSON pipes; never a listener.

Only authenticated streamScreenshot and streamAudio are used. The emulator's
built-in Rtc service and its input/ADB datachannels are deliberately not used.
"""

import argparse
import asyncio
import hashlib
import importlib
from importlib.metadata import version as package_version
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import signal
import struct
import sys
import time
from fractions import Fraction

MAX_LINE = 128 * 1024
MAX_SDP = 48 * 1024
RATE = 48000
SAMPLES = 960
AUDIO_BYTES = SAMPLES * 2 * 2


class PolicyError(Exception):
    """A deliberately non-diagnostic error suitable for a public code."""


def canonical_address(value):
    if not isinstance(value, str) or "%" in value:
        return None
    try:
        address = ipaddress.ip_address(value)
        if address.is_unspecified or address.is_multicast or address.is_link_local:
            return None
        if address.version == 4:
            if int(str(address).split(".", 1)[0]) >= 224:
                return None
        elif "." in value or address.ipv4_mapped is not None or (int(address) >> 32 == 0 and address != ipaddress.IPv6Address("::1")):
            # Exclude mapped/compatible aliases in dotted AND hexadecimal form.
            return None
        return str(address)
    except ValueError:
        return None


def udp_address_allowed(address, allowed):
    """Check actual packet endpoints, not just the initial SDP candidates.

    ICE can learn peer-reflexive candidates from authenticated incoming STUN.
    Rejecting prflx text in SDP does not prevent that network-side path.
    """
    if not isinstance(address, tuple) or len(address) not in (2, 4):
        return False
    host, port = address[:2]
    if not isinstance(host, str) or "%" in host or type(port) is not int or not 32768 <= port <= 65535:
        return False
    parsed = canonical_address(host)
    return parsed is not None and parsed in allowed


class LocalDatagramTransport:
    """All STUN, DTLS, RTP and RTCP sends use this one guarded sendto path."""

    def __init__(self, transport, allowed):
        self._transport = transport
        self._allowed = frozenset(allowed)

    def sendto(self, data, address=None):
        if not udp_address_allowed(address, self._allowed):
            raise PolicyError("udp_target_denied")
        return self._transport.sendto(data, address)

    def __getattr__(self, key):
        return getattr(self._transport, key)


def guarded_stun_protocol(base, allowed):
    policy = frozenset(allowed)

    class LocalStunProtocol(base):
        def connection_made(self, transport):
            # Installed before the datagram endpoint starts receiving packets,
            # so unauthenticated early checks cannot elicit off-host responses.
            super().connection_made(LocalDatagramTransport(transport, policy))

        def datagram_received(self, data, address):
            if udp_address_allowed(address, policy):
                super().datagram_received(data, address)

    LocalStunProtocol._agent_mobile_base = base
    return LocalStunProtocol


def install_udp_policy(allowed):
    """Reviewed, version-gated adapter inside this single-peer worker process.

    aioice's UDP factory is private. Fail closed on an unreviewed dependency;
    each created protocol retains an immutable policy snapshot. Other worker
    processes and the node service are not affected by this module binding.
    """
    import aioice.ice
    if package_version("aiortc") != "1.16.0" or package_version("aioice") != "0.13.0":
        raise PolicyError("unreviewed_ice_dependency")
    base = getattr(aioice.ice.StunProtocol, "_agent_mobile_base", aioice.ice.StunProtocol)
    if base.__module__ != "aioice.ice" or base.__name__ != "StunProtocol" or not all(callable(getattr(base, name, None)) for name in ("connection_made", "datagram_received", "send_data", "send_stun")):
        raise PolicyError("unsupported_ice_transport")
    aioice.ice.StunProtocol = guarded_stun_protocol(base, allowed)


def local_addresses():
    import ifaddr
    result = {"127.0.0.1", "::1"}
    for adapter in ifaddr.get_adapters():
        for entry in adapter.ips:
            value = entry.ip[0] if isinstance(entry.ip, tuple) else entry.ip
            address = canonical_address(str(value))
            if address is not None:
                result.add(address)
    return result


def validate_endpoint(value):
    match = re.fullmatch(r"(127\.0\.0\.1|\[::1\]):([0-9]{1,5})", value or "")
    if not match or not 1024 <= int(match.group(2)) <= 65535:
        raise PolicyError("grpc_endpoint_denied")
    return value


def validate_candidate(line, allowed):
    fields = line.removeprefix("a=candidate:").split()
    if len(fields) < 8 or fields[1] != "1" or fields[2].lower() != "udp" or fields[6] != "typ" or fields[7] != "host":
        raise PolicyError("ice_candidate_denied")
    try:
        address = canonical_address(fields[4])
        if address is None or address not in allowed or not 32768 <= int(fields[5]) <= 65535:
            raise ValueError()
        if not 0 <= int(fields[3]) <= 2**32 - 1:
            raise ValueError()
    except ValueError:
        raise PolicyError("ice_candidate_denied") from None
    if len(fields[0]) > 64 or (len(fields) - 8) % 2:
        raise PolicyError("ice_candidate_denied")
    for key, value in zip(fields[8::2], fields[9::2]):
        if key not in {"generation", "network-id", "network-cost", "ufrag"} or len(value) > 256:
            raise PolicyError("ice_candidate_denied")


def validate_sdp(value, allowed, answer=False):
    """Validate before aiortc can resolve names or open any remote sockets."""
    if not isinstance(value, str) or not 1 <= len(value.encode()) <= MAX_SDP or "\x00" in value:
        raise PolicyError("sdp_denied")
    if "\r" in value.replace("\r\n", ""):
        raise PolicyError("sdp_denied")
    lines = value.replace("\r\n", "\n").split("\n")
    media = []
    current = None
    candidates = 0
    for line in lines:
        if not line:
            continue
        if len(line) > 2048 or len(line) < 2 or line[1] != "=":
            raise PolicyError("sdp_denied")
        if line.startswith("m="):
            fields = line[2:].split()
            if len(fields) < 4 or fields[0] not in {"audio", "video"} or fields[2] != "UDP/TLS/RTP/SAVPF":
                raise PolicyError("media_denied")
            try:
                if not 1 <= int(fields[1]) <= 65535:
                    raise ValueError()
            except ValueError:
                raise PolicyError("media_denied") from None
            current = {"kind": fields[0], "direction": None, "setup": None, "candidates": 0, "mux": False}
            media.append(current)
        elif line.startswith("c="):
            fields = line[2:].split()
            try:
                if len(fields) != 3 or fields[0] != "IN" or fields[1] not in {"IP4", "IP6"}:
                    raise ValueError()
                address = fields[2] if fields[2] in {"0.0.0.0", "::"} else canonical_address(fields[2])
                if address is None or (address not in allowed and address not in {"0.0.0.0", "::"}):
                    raise ValueError()
            except ValueError:
                raise PolicyError("connection_address_denied") from None
        elif line in {"a=recvonly", "a=sendonly", "a=sendrecv", "a=inactive"}:
            if not current or current["direction"] is not None:
                raise PolicyError("direction_denied")
            current["direction"] = line[2:]
        elif line.startswith("a=setup:"):
            if not current or current["setup"] is not None:
                raise PolicyError("dtls_role_denied")
            current["setup"] = line[8:]
        elif line.startswith("a=candidate:"):
            if not current:
                raise PolicyError("ice_candidate_denied")
            validate_candidate(line, allowed)
            current["candidates"] += 1
            candidates += 1
            if candidates > 32:
                raise PolicyError("ice_candidate_denied")
        elif line == "a=rtcp-mux":
            if not current:
                raise PolicyError("media_denied")
            current["mux"] = True
        elif line.startswith("a=rtcp:"):
            fields = line[7:].split()
            try:
                if not fields or not 1 <= int(fields[0]) <= 65535:
                    raise ValueError()
                if len(fields) > 1 and (len(fields) != 4 or fields[1] != "IN" or fields[2] not in {"IP4", "IP6"} or (fields[3] if fields[3] in {"0.0.0.0", "::"} else canonical_address(fields[3])) not in allowed | {"0.0.0.0", "::"}):
                    raise ValueError()
            except ValueError:
                raise PolicyError("rtcp_address_denied") from None
        elif line.startswith(("a=remote-candidates:", "a=ice-lite", "a=sctp", "a=dcmap", "a=dcsa")):
            raise PolicyError("media_denied")
        elif line.startswith("a="):
            attribute = line[2:].split(":", 1)[0]
            if attribute not in {"group", "msid-semantic", "extmap-allow-mixed", "ice-ufrag", "ice-pwd", "ice-options", "fingerprint", "mid", "rtpmap", "fmtp", "rtcp-fb", "extmap", "rtcp-rsize", "end-of-candidates", "ssrc", "ssrc-group", "msid"}:
                raise PolicyError("attribute_denied")
    if len(media) != 2 or {item["kind"] for item in media} != {"audio", "video"}:
        raise PolicyError("media_denied")
    for item in media:
        if item["direction"] != ("sendonly" if answer else "recvonly") or not item["candidates"] or not item["mux"]:
            raise PolicyError("direction_denied")
        if item["setup"] not in ({"active", "passive"} if answer else {"actpass"}):
            raise PolicyError("dtls_role_denied")
    return value


def validate_start(value):
    if not isinstance(value, dict) or set(value) != {"type", "offer", "authorization"} or value["type"] != "start":
        raise PolicyError("protocol_denied")
    authorization = value["authorization"]
    if not isinstance(authorization, dict) or set(authorization) != {"streamScreenshot", "streamAudio"}:
        raise PolicyError("authorization_denied")
    for token in authorization.values():
        if not isinstance(token, str) or not re.fullmatch(r"Bearer [A-Za-z0-9_.-]{1,8192}", token):
            raise PolicyError("authorization_denied")
    return value


def load_protos(directory):
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise PolicyError("proto_configuration_invalid")
    try:
        manifest_file = root / "manifest.json"
        if manifest_file.is_symlink() or manifest_file.stat().st_size > 16384:
            raise ValueError()
        manifest = json.loads(manifest_file.read_text())
        names = {"emulator_controller_pb2.py", "emulator_controller_pb2_grpc.py"}
        if manifest.get("schema") != 1 or set(manifest["generated"]) != names:
            raise ValueError()
        for name in names:
            filename = root / name
            if filename.is_symlink() or not filename.is_file() or filename.stat().st_size > 4*1024*1024:
                raise ValueError()
            if hashlib.sha256(filename.read_bytes()).hexdigest() != manifest["generated"][name]:
                raise ValueError()
        sys.path.insert(0, str(root))
        return importlib.import_module("emulator_controller_pb2"), importlib.import_module("emulator_controller_pb2_grpc")
    except (OSError, ValueError, KeyError, ImportError):
        raise PolicyError("proto_configuration_invalid") from None


class GrpcSources:
    def __init__(self, args, authorization):
        import grpc
        self.pb, rpc = load_protos(args.proto_dir)
        self.width, self.height = args.width, args.height
        self.authorization = authorization
        credentials = grpc.local_channel_credentials(grpc.LocalConnectionType.LOCAL_TCP)
        self.channel = grpc.aio.secure_channel(validate_endpoint(args.grpc_address), credentials, options=[
            ("grpc.max_receive_message_length", 4*args.width*args.height + 65536),
            ("grpc.max_send_message_length", 65536), ("grpc.enable_retries", 0)])
        self.stub = rpc.EmulatorControllerStub(self.channel)

    async def images(self):
        import av
        request = self.pb.ImageFormat(format=self.pb.ImageFormat.PNG, width=self.width, height=self.height, display=0)
        call = self.stub.streamScreenshot(request, metadata=[("authorization", self.authorization["streamScreenshot"])])
        decoder = av.CodecContext.create("png", "r")
        try:
            async for result in call:
                value = result.image
                if len(value) < 33 or len(value) > 4*self.width*self.height+65536 or value[:8] != b"\x89PNG\r\n\x1a\n" or value[12:16] != b"IHDR":
                    raise PolicyError("screen_source_invalid")
                width, height = struct.unpack(">II", value[16:24])
                if not 1 <= width <= self.width or not 1 <= height <= self.height:
                    raise PolicyError("screen_source_invalid")
                frames = decoder.decode(av.Packet(value))
                if len(frames) != 1 or frames[0].width != width or frames[0].height != height:
                    raise PolicyError("screen_source_invalid")
                yield frames[0]
        finally:
            call.cancel()

    async def audio(self):
        request = self.pb.AudioFormat(samplingRate=RATE, channels=self.pb.AudioFormat.Stereo, format=self.pb.AudioFormat.AUD_FMT_S16)
        call = self.stub.streamAudio(request, metadata=[("authorization", self.authorization["streamAudio"])])
        try:
            async for result in call:
                value = result.audio
                if result.format.samplingRate != RATE or result.format.channels != self.pb.AudioFormat.Stereo or result.format.format != self.pb.AudioFormat.AUD_FMT_S16 or len(value) > 1024*1024 or len(value) % 4:
                    raise PolicyError("audio_source_invalid")
                yield value
        finally:
            call.cancel()

    async def close(self):
        await self.channel.close()


def make_tracks(sources, fps, failed):
    import av
    from aiortc import MediaStreamTrack

    class Video(MediaStreamTrack):
        kind = "video"

        def __init__(self):
            super().__init__()
            self.frame = None
            self.changed = asyncio.Event()
            self.started = time.monotonic()
            self.next_at = self.started
            self.task = asyncio.create_task(self.produce())

        async def produce(self):
            try:
                async for frame in sources.images():
                    self.frame = frame
                    self.changed.set()
                failed("screen_source_ended")
            except asyncio.CancelledError:
                pass
            except Exception:
                failed("screen_source_failed")

        async def recv(self):
            if self.frame is None:
                await asyncio.wait_for(self.changed.wait(), 15)
            await asyncio.sleep(max(0, self.next_at - time.monotonic()))
            now = time.monotonic()
            self.next_at = max(self.next_at + 1/fps, now)
            frame = self.frame.reformat(format="yuv420p")
            frame.pts = round((now-self.started)*90000)
            frame.time_base = Fraction(1, 90000)
            return frame

        def stop(self):
            self.task.cancel()
            super().stop()

    class Audio(MediaStreamTrack):
        kind = "audio"

        def __init__(self):
            super().__init__()
            self.buffer = bytearray()
            self.samples = 0
            self.next_at = time.monotonic()
            self.task = asyncio.create_task(self.produce())

        async def produce(self):
            try:
                async for value in sources.audio():
                    self.buffer.extend(value)
                    # Keep at most 200 ms, dropping oldest whole sample frames.
                    if len(self.buffer) > AUDIO_BYTES*10:
                        del self.buffer[:len(self.buffer)-AUDIO_BYTES*10]
                failed("audio_source_ended")
            except asyncio.CancelledError:
                pass
            except Exception:
                failed("audio_source_failed")

        async def recv(self):
            await asyncio.sleep(max(0, self.next_at-time.monotonic()))
            self.next_at = max(self.next_at + .02, time.monotonic())
            value = bytes(self.buffer[:AUDIO_BYTES])
            del self.buffer[:AUDIO_BYTES]
            value += bytes(AUDIO_BYTES-len(value))
            frame = av.AudioFrame(format="s16", layout="stereo", samples=SAMPLES)
            frame.planes[0].update(value)
            frame.sample_rate = RATE
            frame.pts = self.samples
            frame.time_base = Fraction(1, RATE)
            self.samples += SAMPLES
            return frame

        def stop(self):
            self.task.cancel()
            super().stop()

    return Video(), Audio()


class WorkerPeer:
    """Inject sources for tests; production always constructs GrpcSources."""

    def __init__(self, args, sources, emit, allowed=None):
        from aiortc import RTCPeerConnection, RTCConfiguration, RTCBundlePolicy
        self.args = args
        self.sources = sources
        self.emit = emit
        self.allowed = local_addresses() if allowed is None else allowed
        install_udp_policy(self.allowed)
        self.closed = asyncio.Event()
        self.closing = False
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=[], bundlePolicy=RTCBundlePolicy.MAX_BUNDLE))
        self.tracks = []

        @self.pc.on("connectionstatechange")
        async def state_changed():
            self.emit({"type": "state", "state": self.pc.connectionState})
            if self.pc.connectionState == "failed":
                self.fail("peer_connection_failed")

        @self.pc.on("datachannel")
        def data_channel(channel):
            channel.close()
            self.fail("unexpected_datachannel")

        @self.pc.on("track")
        def incoming_track(track):
            track.stop()
            self.fail("unexpected_incoming_media")

    def fail(self, code):
        if not self.closing:
            self.emit({"type": "error", "code": code})
            asyncio.create_task(self.close())

    async def negotiate(self, offer):
        from aiortc import RTCSessionDescription
        validate_sdp(offer, self.allowed)
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=offer, type="offer"))
        self.tracks = list(make_tracks(self.sources, self.args.fps, self.fail))
        for track in self.tracks:
            self.pc.addTrack(track)
        await self.pc.setLocalDescription(await self.pc.createAnswer())
        if self.closing:
            raise PolicyError("peer_closed")
        validate_sdp(self.pc.localDescription.sdp, self.allowed, answer=True)
        self.emit({"type": "answer", "sdp": self.pc.localDescription.sdp})
        self.emit({"type": "ready"})

    async def close(self):
        if self.closing:
            await self.closed.wait()
            return
        self.closing = True
        try:
            for track in self.tracks:
                track.stop()
            await asyncio.gather(self.pc.close(), self.sources.close(), *(track.task for track in self.tracks), return_exceptions=True)
        finally:
            self.closed.set()
            self.emit({"type": "closed"})


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--proto-dir", required=True)
    result.add_argument("--grpc-address", required=True)
    result.add_argument("--width", type=int, default=720)
    result.add_argument("--height", type=int, default=1280)
    result.add_argument("--fps", type=int, default=15)
    result.add_argument("--max-lifetime", type=int, default=600)
    return result


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":"))+"\n")
    sys.stdout.flush()


async def read_message(reader, timeout=None):
    try:
        line = await asyncio.wait_for(reader.readline(), timeout) if timeout else await reader.readline()
        if not line:
            return None
        if len(line) > MAX_LINE:
            raise ValueError()
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, asyncio.LimitOverrunError):
        raise PolicyError("protocol_denied") from None


async def run(args):
    validate_endpoint(args.grpc_address)
    if not 64 <= args.width <= 1920 or not 64 <= args.height <= 1920 or not 1 <= args.fps <= 30 or not 1 <= args.max_lifetime <= 600:
        raise PolicyError("configuration_denied")
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LINE)
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    peer = None
    sources = None
    pending = []
    closing = asyncio.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, closing.set)
    try:
        first_read = asyncio.create_task(read_message(reader, 15))
        signaled = asyncio.create_task(closing.wait())
        pending.extend([first_read, signaled])
        done, _ = await asyncio.wait([first_read, signaled], return_when=asyncio.FIRST_COMPLETED)
        if signaled in done:
            first_read.cancel()
            await asyncio.gather(first_read, return_exceptions=True)
            return
        initial = first_read.result()
        if initial is None or initial == {"type": "close"}:
            emit({"type": "closed"})
            return
        start = validate_start(initial)
        allowed = local_addresses()
        validate_sdp(start["offer"], allowed)
        sources = GrpcSources(args, start["authorization"])
        peer = WorkerPeer(args, sources, emit, allowed)
        incoming = asyncio.create_task(read_message(reader))
        lifetime = asyncio.create_task(asyncio.sleep(args.max_lifetime))
        negotiation = asyncio.create_task(peer.negotiate(start["offer"]))
        pending.extend([incoming, lifetime, negotiation])
        done, _ = await asyncio.wait([negotiation, signaled, incoming, lifetime], timeout=25, return_when=asyncio.FIRST_COMPLETED)
        if negotiation not in done:
            negotiation.cancel()
            await asyncio.gather(negotiation, return_exceptions=True)
            if incoming in done:
                message = incoming.result()
                if message is not None and message != {"type": "close"}:
                    raise PolicyError("protocol_denied")
            elif not closing.is_set() and lifetime not in done:
                raise PolicyError("negotiation_timeout")
            return
        await negotiation
        closed = asyncio.create_task(peer.closed.wait())
        pending.append(closed)
        done, _ = await asyncio.wait([incoming, lifetime, signaled, closed], return_when=asyncio.FIRST_COMPLETED)
        if incoming in done:
            message = incoming.result()
            if message is not None and message != {"type": "close"}:
                raise PolicyError("protocol_denied")
    finally:
        transport.close()
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if peer:
            await peer.close()
        elif sources:
            await sources.close()


def main():
    # Third-party library diagnostics may contain SDP/IPs; protocol output never
    # includes their exception details or source credentials.
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(run(parser().parse_args()))
    except PolicyError as error:
        emit({"type": "error", "code": str(error)})
        return 1
    except (Exception, KeyboardInterrupt):
        emit({"type": "error", "code": "worker_failed"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
