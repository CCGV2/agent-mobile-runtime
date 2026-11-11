#!/usr/bin/env python3
"""Policy tests need stdlib; the opt-in installed-dependency test uses real RTP."""

import asyncio
from importlib.util import find_spec, module_from_spec, spec_from_file_location
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import textwrap
from types import SimpleNamespace
import unittest

WORKER = Path(__file__).resolve().parents[1] / "webrtc" / "worker.py"
SPEC = spec_from_file_location("mobile_media_worker", WORKER)
worker = module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def offer(address="127.0.0.1", port=50000):
    lines = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0 1"]
    for index, kind in enumerate(("audio", "video")):
        lines += [f"m={kind} 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", f"a=mid:{index}", "a=recvonly", "a=rtcp-mux", "a=setup:actpass", f"a=candidate:1 1 udp 2130706431 {address} {port} typ host", "a=end-of-candidates"]
    return "\r\n".join(lines)+"\r\n"


class PolicyTests(unittest.TestCase):
    def test_actual_udp_packets_and_sends_cannot_learn_off_host_peer_reflexive_destinations(self):
        received, sent = [], []

        class Transport:
            def sendto(self, data, address):
                sent.append((data, address))

            def get_extra_info(self, name):
                return name

        class Protocol:
            def connection_made(self, transport):
                self.transport = transport

            def datagram_received(self, data, address):
                # Represents the library's authenticated check_incoming path.
                received.append((data, address))
                self.transport.sendto(b"binding-response", address)

        allowed = {"127.0.0.1", "::1", "192.168.10.2"}
        protocol = worker.guarded_stun_protocol(Protocol, allowed)()
        protocol.connection_made(Transport())
        # A valid ICE credential does not grant permission to nominate a
        # source that was absent from the local-host network policy.
        for source in (("203.0.113.9", 55000), ("192.168.10.3", 55000), ("127.0.0.1", 22), ("::ffff:192.168.10.2", 55000), ("unresolved.local", 55000)):
            protocol.datagram_received(b"authenticated-stun-check", source)
            with self.assertRaises(worker.PolicyError):
                protocol.transport.sendto(b"consent-or-rtp", source)
        self.assertEqual(received, [])
        self.assertEqual(sent, [])
        for source in (("127.0.0.1", 55000), ("::1", 55001, 0, 0), ("192.168.10.2", 55002)):
            protocol.datagram_received(b"authenticated-stun-check", source)
        self.assertEqual(len(received), 3)
        self.assertEqual(len(sent), 3)
        self.assertEqual(protocol.transport.get_extra_info("sockname"), "sockname")

    def test_linklocal_mapped_compatible_and_zone_addresses_fail_even_if_allowlisted(self):
        forbidden = {"169.254.1.2", "fe80::1", "fe90::1", "::ffff:192.168.10.2", "::ffff:c0a8:a02", "::192.168.10.2", "::c0a8:a02", "fe80::1%en0", "ff02::1", "224.0.0.1", "240.0.0.1", "0.0.0.0", "::"}
        for address in forbidden:
            with self.subTest(address=address):
                self.assertIsNone(worker.canonical_address(address))
                self.assertFalse(worker.udp_address_allowed((address, 55000), forbidden))
                with self.assertRaises(worker.PolicyError):
                    worker.validate_sdp(offer(address), forbidden)
        self.assertEqual(worker.canonical_address("::1"), "::1")
        self.assertEqual(worker.canonical_address("FD00:0000::0001"), "fd00::1")

    def test_accepts_only_complete_recvonly_audio_video_on_exact_local_addresses(self):
        self.assertEqual(worker.validate_sdp(offer(), {"127.0.0.1"}), offer())
        self.assertEqual(worker.validate_sdp(offer("192.168.1.8"), {"192.168.1.8"}), offer("192.168.1.8"))

    def test_rejects_remote_ice_dns_relays_tcp_and_low_ports(self):
        for bad in (
            offer("8.8.8.8"), offer("private-host.local"), offer(port=22),
            offer().replace("1 1 udp", "1 2 udp"),
            offer().replace("1 1 udp", "1 1 tcp"),
            offer().replace("typ host", "typ relay"),
            offer().replace("typ host", "typ srflx raddr 127.0.0.1 rport 50000"),
            offer().replace("c=IN IP4 0.0.0.0", "c=IN IP4 8.8.8.8"),
            offer()+"a=rtcp:50000 IN IP4 8.8.8.8\r\n",
            offer()+"a=unexpected-extension:network\r\n",
        ):
            with self.subTest():
                with self.assertRaises(worker.PolicyError):
                    worker.validate_sdp(bad, {"127.0.0.1"})

    def test_datachannel_and_incoming_media_are_rejected_before_negotiation(self):
        for bad in (
            offer()+"m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
            offer().replace("a=recvonly", "a=sendrecv"),
            offer().replace("a=recvonly", "a=sendonly"),
            offer().replace("m=video", "m=audio"),
            offer().replace("a=setup:actpass", "a=setup:active"),
            offer().replace("a=recvonly\r\n", ""),
        ):
            with self.subTest():
                with self.assertRaises(worker.PolicyError):
                    worker.validate_sdp(bad, {"127.0.0.1"})

    def test_input_is_bounded_and_uses_only_two_explicit_method_credentials(self):
        good = {"type": "start", "offer": offer(), "authorization": {"streamScreenshot": "Bearer a.b.c", "streamAudio": "Bearer d.e.f"}}
        self.assertEqual(worker.validate_start(good), good)
        for auth in ({}, {"streamScreenshot": "Bearer a.b.c"}, {**good["authorization"], "sendKey": "Bearer a.b.c"}, {"streamScreenshot": "Bearer secret\r\ninjection", "streamAudio": "Bearer a.b.c"}):
            with self.assertRaises(worker.PolicyError):
                worker.validate_start({**good, "authorization": auth})
        for value in (None, [], {**good, "shell": "whoami"}):
            with self.assertRaises(worker.PolicyError):
                worker.validate_start(value)
        with self.assertRaises(worker.PolicyError):
            worker.validate_sdp("x"*(worker.MAX_SDP+1), {"127.0.0.1"})

    def test_grpc_target_must_be_loopback_and_no_credential_is_an_argument(self):
        for valid in ("127.0.0.1:8554", "[::1]:8554"):
            self.assertEqual(worker.validate_endpoint(valid), valid)
        for invalid in ("localhost:8554", "192.168.1.8:8554", "127.0.0.1:22", "https://127.0.0.1:8554", "127.0.0.1:8554/path"):
            with self.assertRaises(worker.PolicyError):
                worker.validate_endpoint(invalid)
        self.assertNotIn("authorization", worker.parser().format_help())

    def test_modified_generated_protos_are_rejected_without_import(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            manifest = {"schema": 1, "generated": {"emulator_controller_pb2.py": "0"*64, "emulator_controller_pb2_grpc.py": "0"*64}}
            (root / "manifest.json").write_text(json.dumps(manifest))
            (root / "emulator_controller_pb2.py").write_text('raise RuntimeError("must not import")')
            (root / "emulator_controller_pb2_grpc.py").write_text("pass")
            with self.assertRaisesRegex(worker.PolicyError, "proto_configuration_invalid"):
                worker.load_protos(str(root))

    def test_worker_eof_before_start_exits_without_dependencies_or_listener(self):
        result = subprocess.run([sys.executable, str(WORKER), "--proto-dir", "/unused", "--grpc-address", "127.0.0.1:8554"], input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"type": "closed"})
        self.assertEqual(result.stderr, b"")

    def test_eof_or_signal_during_negotiation_closes_the_peer_without_timeout(self):
        # Test-only class injection, never a production CLI switch.
        harness = textwrap.dedent('''
            import asyncio,importlib.util,sys
            from types import SimpleNamespace
            spec=importlib.util.spec_from_file_location('worker',sys.argv[1])
            worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
            worker.local_addresses=lambda:{'127.0.0.1'}
            class Source:
                def __init__(self,*args):pass
                async def close(self):pass
            class Peer:
                def __init__(self,args,source,emit,allowed):self.closed=asyncio.Event();self.emit=emit
                async def negotiate(self,offer):
                    self.emit({'type':'state','state':'starting'})
                    await asyncio.Event().wait()
                async def close(self):self.closed.set();self.emit({'type':'closed'})
            worker.GrpcSources=Source;worker.WorkerPeer=Peer
            args=SimpleNamespace(grpc_address='127.0.0.1:8554',proto_dir='/unused',width=720,height=1280,fps=15,max_lifetime=600)
            asyncio.run(worker.run(args))
        ''')
        start = {"type": "start", "offer": offer(), "authorization": {"streamScreenshot": "Bearer a.b.c", "streamAudio": "Bearer a.b.c"}}
        payload = (json.dumps(start)+"\n").encode()
        result = subprocess.run([sys.executable, "-c", harness, str(WORKER)], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn({"type": "closed"}, [json.loads(line) for line in result.stdout.splitlines()])
        process = subprocess.Popen([sys.executable, "-c", harness, str(WORKER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            process.stdin.write(payload); process.stdin.flush()
            self.assertEqual(json.loads(process.stdout.readline()), {"type": "state", "state": "starting"})
            process.terminate()
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0)
            self.assertIn({"type": "closed"}, [json.loads(line) for line in stdout.splitlines()])
            self.assertEqual(stderr, b"")
        finally:
            if process.poll() is None:
                process.kill(); process.communicate()


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_ndjson_reader_rejects_oversized_malformed_or_nonobject_input(self):
        for value in (b"[]\n", b"{\n", b"x"*(worker.MAX_LINE+1)+b"\n"):
            reader = asyncio.StreamReader(limit=worker.MAX_LINE)
            reader.feed_data(value)
            reader.feed_eof()
            with self.assertRaises(worker.PolicyError):
                await worker.read_message(reader)


HAVE_MEDIA = find_spec("aiortc") is not None and find_spec("av") is not None


@unittest.skipUnless(HAVE_MEDIA, "Install webrtc/requirements.txt to run real synthetic RTP verification.")
class SyntheticPeerTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_real_peers_deliver_audio_video_then_close_owned_sockets(self):
        import av
        from aiortc import RTCPeerConnection, RTCConfiguration, RTCBundlePolicy, RTCSessionDescription

        class Sources:
            closed = False

            async def images(self):
                while not self.closed:
                    frame = av.VideoFrame(160, 120, "yuv420p")
                    for index, plane in enumerate(frame.planes):
                        plane.update(bytes([80 if index == 0 else 128])*plane.buffer_size)
                    yield frame
                    await asyncio.sleep(1/15)

            async def audio(self):
                samples = []
                for index in range(worker.SAMPLES):
                    value = round(8000*math.sin(2*math.pi*440*index/worker.RATE))
                    samples += [value, value]
                packet = struct.pack("<"+"h"*len(samples), *samples)
                while not self.closed:
                    yield packet
                    await asyncio.sleep(.02)

            async def close(self):
                self.closed = True

        browser = RTCPeerConnection(RTCConfiguration(iceServers=[], bundlePolicy=RTCBundlePolicy.MAX_BUNDLE))
        browser.addTransceiver("audio", direction="recvonly")
        browser.addTransceiver("video", direction="recvonly")
        received = {}
        tasks = []

        @browser.on("track")
        def got_track(track):
            async def receive():
                for _ in range(40):
                    frame = await track.recv()
                    if track.kind == "video" or any(bytes(frame.planes[0])):
                        received[track.kind] = frame
                        return
                raise AssertionError("Expected non-silent synthetic audio")
            tasks.append(asyncio.create_task(receive()))

        sources = Sources()
        events = []
        peer = worker.WorkerPeer(SimpleNamespace(fps=15), sources, events.append)
        try:
            await browser.setLocalDescription(await browser.createOffer())
            await peer.negotiate(browser.localDescription.sdp)
            answer = next(event["sdp"] for event in events if event["type"] == "answer")
            await browser.setRemoteDescription(RTCSessionDescription(answer, "answer"))
            await asyncio.wait_for(asyncio.gather(*tasks), 20)
            self.assertEqual(set(received), {"audio", "video"})
            self.assertEqual(received["video"].width, 160)
            self.assertIsNone(peer.pc.sctp)
            self.assertIsNone(browser.sctp)
        finally:
            await peer.close()
            await browser.close()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        self.assertTrue(sources.closed)
        self.assertEqual(peer.pc.connectionState, "closed")
        self.assertTrue(all(track.task.done() for track in peer.tracks))
        self.assertTrue(peer.closed.is_set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
