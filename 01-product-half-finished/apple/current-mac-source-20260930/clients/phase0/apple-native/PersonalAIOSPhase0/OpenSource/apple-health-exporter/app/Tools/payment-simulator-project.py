#!/usr/bin/env python3
"""Make an isolated simulator test project. The shipped ARTC binary has no simulator slice.

Only this generated project replaces ARTC with an explicitly unavailable implementation.
All payment/UI/Core sources and contracts are the original files. No device build uses it.
"""
import argparse
import json
import plistlib
import re
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--without-place-bootstrap", action="store_true",
                    help="Skip app-level places restoration when simulator CoreLocation is unavailable; unit implementations stay unchanged")
args = parser.parse_args()
app = Path(__file__).resolve().parents[1]
original = app / "HealthKitExporter.xcodeproj"
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
project = output / original.name
project.mkdir(exist_ok=True)
value = json.loads(subprocess.check_output([
    "plutil", "-convert", "json", "-o", "-", str(original / "project.pbxproj")]))
objects = value["objects"]
root = objects[value["rootObject"]]
objects[root["mainGroup"]]["path"] = str(app)
objects[root["mainGroup"]]["sourceTree"] = "<absolute>"
# Simulator Keychain tests need an application identity, even with ad-hoc signing.
# These entitlements never enter the device project and require no signing key or profile.
entitlements = plistlib.loads((app / "App/HealthKitExporter.entitlements").read_bytes())
entitlements.update({"application-identifier": "ai.paios.personal.phase0",
                     "keychain-access-groups": ["ai.paios.personal.phase0"], "get-task-allow": True})
simulator_entitlements = output / "SimulatorHealthKitExporter.entitlements"
simulator_entitlements.write_bytes(plistlib.dumps(entitlements))
if args.without_place_bootstrap:
    # An observed synchronous CoreLocation hang prevents XCTest from connecting at app launch.
    # Exclude only that unrelated bootstrap from this generated test app, never the shipped source.
    composition = (app / "App/AssistantComposition.swift").read_text()
    first = composition.index("    func restorePlaceSensing() {")
    last = composition.index("\n    func flushPlaces()", first)
    stub = output / "SimulatorComposition.swift"
    stub.write_text('#if !targetEnvironment(simulator)\n#error("Simulator-only test bootstrap")\n#endif\n'
                    + composition[:first] + "    func restorePlaceSensing() {}\n" + composition[last:])
    for obj in objects.values():
        if obj.get("path") == "AssistantComposition.swift":
            obj["path"], obj["sourceTree"] = str(stub), "<absolute>"
# Remove only the unsupported device-only package from the generated dependency graph.
unsupported = {key for key, obj in objects.items()
               if obj.get("productName") == "AliyunARTC" or obj.get("relativePath") == "Vendor/AliyunARTC"}
unsupported |= {key for key, obj in objects.items() if obj.get("productRef") in unsupported}
for key in unsupported:
    del objects[key]
for obj in objects.values():
    for key, field in obj.items():
        if isinstance(field, list):
            obj[key] = [item for item in field if not isinstance(item, str) or item not in unsupported]
    if obj.get("repositoryURL") == "https://github.com/livekit/client-sdk-swift.git":
        # The package suite's exact dependency is its existing manifest, not the stale Xcode pin.
        version = re.search(r'url:\s*"https://github.com/livekit/client-sdk-swift.git",\s*exact:\s*"([^"]+)"',
                            (app / "Package.swift").read_text()).group(1)
        obj["requirement"] = {"kind": "exactVersion", "version": version}
    if obj.get("isa") == "XCLocalSwiftPackageReference":
        obj["relativePath"] = str((app / obj["relativePath"]).resolve())
    if obj.get("sourceTree") == "SOURCE_ROOT":
        obj["path"] = str((app / obj["path"]).resolve())
        obj["sourceTree"] = "<absolute>"
    settings = obj.get("buildSettings", {})
    if "PRODUCT_BUNDLE_IDENTIFIER" in settings:
        settings["CODE_SIGN_STYLE"] = "Manual"
        settings["CODE_SIGN_IDENTITY"] = "-"
    for key in ("INFOPLIST_FILE", "CODE_SIGN_ENTITLEMENTS"):
        if key in settings:
            settings[key] = str(app / settings[key])
    if settings.get("PRODUCT_BUNDLE_IDENTIFIER") == "ai.paios.personal.phase0":
        settings["CODE_SIGN_ENTITLEMENTS"] = str(simulator_entitlements)
    if obj.get("path") == "ARTCCallClient.swift":
        obj["path"] = str(output / "SimulatorARTC.swift")
        obj["sourceTree"] = "<absolute>"
protocol = (app / "Core/ARTCCallClient.swift").read_text().split("#if os(iOS)", 1)[0]
(output / "SimulatorARTC.swift").write_text(protocol + '''
#if !targetEnvironment(simulator)
#error("The payment test harness is simulator-only")
#endif
@MainActor
final class AliyunARTCCallClient: ARTCCallClient {
    init(preview: AssistantVideoPreviewModel) {}
    func join(_ media: CentralCall.Media, camera: Bool,
              events: @escaping @Sendable (ARTCCallEvent) -> Void) throws { throw CentralTextError.unavailable }
    func setMedia(_ source: AssistantMediaSource, enabled: Bool) throws { throw CentralTextError.unavailable }
    func switchCamera() throws -> Bool { throw CentralTextError.unavailable }
    func flushPlayback() {}
    func leave() async throws {}
}
''')
# Compile every package test on the simulator, including files absent from the older Xcode scheme.
# The package also includes WatchCore; the iPhone target does not include those watch-only types.
host = next(obj for obj in objects.values() if obj.get("isa") == "PBXNativeTarget" and obj.get("name") == "HealthKitExporter")
host_sources = next(objects[key] for key in host["buildPhases"] if objects[key]["isa"] == "PBXSourcesBuildPhase")
host_references = {objects[objects[key]["fileRef"]].get("path", "").split("/")[-1] for key in host_sources["files"]}
for index, path in enumerate(sorted((app / "WatchCore").glob("*.swift")), 1):
    if path.name in host_references:
        continue
    ref, build = f"AC340000000000000000{index:04X}", f"AC330000000000000000{index:04X}"
    objects[ref] = {"isa": "PBXFileReference", "path": str(path), "sourceTree": "<absolute>", "lastKnownFileType": "sourcecode.swift"}
    objects[build] = {"isa": "PBXBuildFile", "fileRef": ref}
    host_sources["files"].append(build)
tests = next(obj for obj in objects.values() if obj.get("isa") == "PBXNativeTarget" and obj.get("name") == "HealthKitExporterTests")
source_phase = next(objects[key] for key in tests["buildPhases"] if objects[key]["isa"] == "PBXSourcesBuildPhase")
resource_phase = next(objects[key] for key in tests["buildPhases"] if objects[key]["isa"] == "PBXResourcesBuildPhase")
references = {objects[objects[key]["fileRef"]].get("path", "").split("/")[-1] for key in source_phase["files"]}
extra = [path for path in sorted((app / "Tests").glob("*.swift")) if path.name not in references]
resources = output / "SimulatorTestResources.swift"
resources.write_text("import Foundation\nprivate final class SimulatorTestResources: NSObject {}\nextension Bundle { static var module: Bundle { Bundle(for: SimulatorTestResources.self) } }\n")
for index, path in enumerate(extra + [resources, app / "Tests/Fixtures",
                                     app / "Tests/Fixtures/CentralText/watch-run-control.fixture.json"], 1):
    ref, build = f"AC320000000000000000{index:04X}", f"AC310000000000000000{index:04X}"
    folder = path.is_dir()
    objects[ref] = {"isa": "PBXFileReference", "path": str(path), "sourceTree": "<absolute>",
                    "lastKnownFileType": "folder" if folder else "text.json" if path.suffix == ".json" else "sourcecode.swift"}
    objects[build] = {"isa": "PBXBuildFile", "fileRef": ref}
    (resource_phase if folder or path.suffix == ".json" else source_phase)["files"].append(build)
(project / "project.pbxproj").write_text(json.dumps(value))
subprocess.run(["plutil", "-convert", "xml1", str(project / "project.pbxproj")], check=True)
for name in ("xcshareddata", "project.xcworkspace"):
    if (original / name).exists():
        shutil.copytree(original / name, project / name, dirs_exist_ok=True)
print(project)
