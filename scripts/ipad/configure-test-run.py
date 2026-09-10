import json
import plistlib
import sys


source, destination = sys.argv[1:3]
gesture = json.dumps(json.load(sys.stdin))
with open(source, "rb") as stream:
    config = plistlib.load(stream)
if "TestConfigurations" in config:
    targets = [target for configuration in config["TestConfigurations"] for target in configuration["TestTargets"]]
else:
    targets = [value for value in config.values() if isinstance(value, dict) and "TestBundlePath" in value]
if not targets:
    raise RuntimeError("No test targets in the Xcode test configuration")
for target in targets:
    target.setdefault("EnvironmentVariables", {})["SIYUAN_GESTURE"] = gesture
with open(destination, "wb") as stream:
    plistlib.dump(config, stream)
