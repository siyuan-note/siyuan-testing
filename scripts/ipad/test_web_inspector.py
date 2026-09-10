import importlib.util
import io
import json
from pathlib import Path
import plistlib
import struct
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("web_inspector", Path(__file__).with_name("web-inspector.py"))
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


def packet(selector, **args):
    data = plistlib.dumps({"__selector": selector, "__argument": args}, fmt=plistlib.FMT_BINARY)
    return struct.pack(">I", len(data)) + data


def message(data):
    return packet("_rpc_applicationSentData:", WIRMessageDataKey=json.dumps(data).encode())


class FakeSocket:
    def __init__(self, incoming):
        self.incoming = io.BytesIO(incoming)
        self.sent = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def connect(self, _address):
        pass

    def settimeout(self, _timeout):
        pass

    def recv(self, size):
        # 模拟分片读取，确保消息边界不依赖单次 recv 的长度。
        return self.incoming.read(min(size, 13))

    def sendall(self, data):
        self.sent.append(plistlib.loads(data[4:]))


class InspectorTests(unittest.TestCase):
    def test_late_safari_registration_and_multiple_queries_share_page_connection(self):
        url = "http://127.0.0.1:6807/stage/build/desktop/?id=test"
        safari = {"WIRApplicationIdentifierKey": "PID:10",
                  "WIRApplicationBundleIdentifierKey": "com.apple.mobilesafari"}
        incoming = packet("_rpc_reportConnectedApplicationList:", WIRApplicationDictionaryKey={})
        incoming += packet("_rpc_applicationConnected:", **safari)
        incoming += packet("_rpc_applicationUpdated:", **safari)
        incoming += packet("_rpc_applicationSentListing:", WIRApplicationIdentifierKey="PID:10",
                           WIRListingKey={"1": {"WIRURLKey": url, "WIRPageIdentifierKey": 1}})
        for target_type in ("frame", "page"):
            incoming += message({"method": "Target.targetCreated", "params": {
                "targetInfo": {"type": target_type, "targetId": target_type + "-1"}}})
        for command_id, value in ((2, "first"), (4, "second")):
            incoming += message({"method": "Target.dispatchMessageFromTarget", "params": {
                "message": json.dumps({"id": command_id, "result": {"result": {"value": value}}})}})
        connection = FakeSocket(incoming)
        output = io.StringIO()
        next_request = json.dumps({"expression": "second()"}) + "\n"
        with patch.object(inspector.subprocess, "check_output", side_effect=[
            "10 launchd_sim /Devices/device/\n", "n/tmp/com.apple.webinspectord_sim.socket\n",
        ]), patch.object(inspector.socket, "socket", return_value=connection), \
                patch.object(inspector.sys, "stdin", io.StringIO(next_request)), \
                patch.object(inspector.sys, "stdout", output):
            inspector.evaluate("device", {"url": url, "expression": "first()"}, session=True)
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], ["first", "second"])
        selectors = [item["__selector"] for item in connection.sent]
        self.assertEqual(selectors.count("_rpc_forwardGetListing:"), 2)
        self.assertEqual(selectors.count("_rpc_forwardSocketSetup:"), 1)
        self.assertEqual(selectors.count("_rpc_forwardDidClose:"), 1)
        commands = [json.loads(item["__argument"]["WIRSocketDataKey"]) for item in connection.sent
                    if item["__selector"] == "_rpc_forwardSocketData:"]
        self.assertEqual([item["params"]["targetId"] for item in commands], ["page-1", "page-1"])
        self.assertEqual([json.loads(item["params"]["message"])["params"]["expression"] for item in commands],
                         ["first()", "second()"])


if __name__ == "__main__":
    unittest.main()
