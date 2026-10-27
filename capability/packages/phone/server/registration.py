"""Merge interface for the manifest loader and the existing phone-runtime factory."""
from pathlib import Path
import json
from capability.packages.load import bind_runtime


def select_transport(selection, legacy, package):
    """The loader's gateway selection is the only switch; existing provider/model/secret config is reused."""
    if "phone" not in selection.get("gateway", []):
        return legacy
    if legacy is None:
        return None
    manifest = json.loads(Path(__file__).parents[1].joinpath('plugin.json').read_text())
    secrets = manifest['extensions']['ai.yimi.capability']['secrets']
    return {**legacy, **bind_runtime(package, legacy, [secret['name'] for secret in secrets])}
