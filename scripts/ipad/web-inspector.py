import json
import plistlib
import socket
import struct
import subprocess
import sys
import time
import uuid


def evaluate(device, request, session=False):
    # 从指定模拟器发现调试套接字，避免连接到其他设备或依赖临时目录名称。
    processes = subprocess.check_output(["ps", "-axo", "pid,args"], text=True)
    pid = next(line.split()[0] for line in processes.splitlines()
               if "launchd_sim " in line and f"/Devices/{device}/" in line)
    files = subprocess.check_output(["lsof", "-a", "-p", pid, "-U", "-Fn"], text=True)
    address = next(line[1:] for line in files.splitlines()
                   if line.startswith("n/") and line.endswith("/com.apple.webinspectord_sim.socket"))
    connection = str(uuid.uuid4()).upper()
    sender = str(uuid.uuid4()).upper()
    deadline = time.monotonic() + request.get("timeout", 20)
    app_id = page_id = None
    attached = False
    evaluated = False
    target_id = None
    command_id = 0

    with socket.socket(socket.AF_UNIX) as stream:
        stream.connect(address)

        def send(selector, **args):
            payload = plistlib.dumps({"__selector": selector, "__argument": {
                "WIRConnectionIdentifierKey": connection, **args,
            }}, fmt=plistlib.FMT_BINARY)
            stream.sendall(struct.pack(">I", len(payload)) + payload)

        def read_exact(size):
            data = b""
            while len(data) < size:
                stream.settimeout(max(0.1, deadline - time.monotonic()))
                chunk = stream.recv(size - len(data))
                if not chunk:
                    raise RuntimeError("Web Inspector disconnected")
                data += chunk
            return data

        def send_expression():
            nonlocal command_id
            command_id += 2
            command = {"id": command_id, "method": "Runtime.evaluate", "params": {
                "expression": request["expression"], "returnByValue": True,
            }}
            wrapped = {"id": command_id + 1, "method": "Target.sendMessageToTarget", "params": {
                "targetId": target_id, "message": json.dumps(command),
            }}
            send("_rpc_forwardSocketData:", WIRApplicationIdentifierKey=app_id,
                 WIRPageIdentifierKey=page_id, WIRSenderKey=sender,
                 WIRSocketDataKey=json.dumps(wrapped).encode())

        send("_rpc_reportIdentifier:")
        try:
            while time.monotonic() < deadline:
                size = struct.unpack(">I", read_exact(4))[0]
                message = plistlib.loads(read_exact(size))
                args = message.get("__argument", {})
                applications = args.get("WIRApplicationDictionaryKey", {})
                # Safari 可能在首次列表之后才连接或就绪，需要继续请求它的页面列表。
                if message["__selector"] in ("_rpc_applicationConnected:", "_rpc_applicationUpdated:"):
                    applications = {args["WIRApplicationIdentifierKey"]: args}
                for key, app in applications.items():
                    if app.get("WIRApplicationBundleIdentifierKey") == "com.apple.mobilesafari":
                        send("_rpc_forwardGetListing:", WIRApplicationIdentifierKey=key)
                if message["__selector"] == "_rpc_applicationSentListing:" and not attached:
                    for page in args.get("WIRListingKey", {}).values():
                        if page.get("WIRURLKey", "") == request["url"]:
                            app_id = args["WIRApplicationIdentifierKey"]
                            page_id = page["WIRPageIdentifierKey"]
                            attached = True
                            send("_rpc_forwardSocketSetup:", WIRApplicationIdentifierKey=app_id,
                                 WIRPageIdentifierKey=page_id, WIRSenderKey=sender,
                                 WIRMessageDataTypeChunkSupportedKey=0)
                            break
                if message["__selector"] != "_rpc_applicationSentData:":
                    continue
                data = json.loads(args["WIRMessageDataKey"])
                if data.get("method") == "Target.targetCreated" and not evaluated:
                    target = data["params"]["targetInfo"]
                    if target["type"] != "page":
                        continue
                    evaluated = True
                    target_id = target["targetId"]
                    send_expression()
                elif data.get("method") == "Target.dispatchMessageFromTarget":
                    reply = json.loads(data["params"]["message"])
                    if reply.get("id") != command_id:
                        continue
                    if "error" in reply or reply.get("result", {}).get("wasThrown"):
                        raise RuntimeError(json.dumps(reply))
                    value = reply["result"]["result"].get("value")
                    if not session:
                        return value
                    # 同一页面复用调试连接，避免每次查询都触发 WebKit 重新注册页面。
                    print(json.dumps(value), flush=True)
                    line = sys.stdin.readline()
                    if not line:
                        return
                    request = json.loads(line)
                    deadline = time.monotonic() + request.get("timeout", 20)
                    send_expression()
            raise TimeoutError(f"No inspectable Safari page at {request['url']}")
        except socket.timeout as error:
            raise TimeoutError(
                f"Web Inspector timed out at {request['url']} (attached={attached}, evaluated={evaluated})"
            ) from error
        finally:
            if attached:
                send("_rpc_forwardDidClose:", WIRApplicationIdentifierKey=app_id,
                     WIRPageIdentifierKey=page_id, WIRSenderKey=sender)


if __name__ == "__main__":
    if "--session" in sys.argv:
        evaluate(sys.argv[1], json.loads(sys.stdin.readline()), session=True)
    else:
        print(json.dumps(evaluate(sys.argv[1], json.load(sys.stdin))))
