"""Keep the canonical release CLI available for expiry even after an image rollback or release pruning."""
import json
import os
from pathlib import Path
import shutil
import tempfile

from data_reset_inventory import file_hash
from data_reset_policy import GUARD, require, sync_directory


def prepare(host):
    parent=host.lock_path().parent
    require(not hasattr(host,'releases') or not parent.resolve().is_relative_to(host.releases.resolve()),
            'RESET_RETENTION_LOCATION_UNSAFE')
    target=parent/'data-reset-runtime-quarantine-v1'
    if target.exists():
        require(target.is_dir() and not target.is_symlink(),'RESET_RETENTION_RUNTIME_UNSAFE')
        manifest=json.loads((target/'manifest.json').read_text())
        require('deploy/cloud/release.py' in manifest['files'],'RESET_RETENTION_RUNTIME_CHANGED')
        require(all(file_hash(target/name) == sha for name,sha in manifest['files'].items()),'RESET_RETENTION_RUNTIME_CHANGED')
    else:
        root=Path(__file__).resolve().parents[2]
        sources=[p for p in (root/'deploy/cloud').glob('*.py') if not p.name.startswith('test_')]
        sources.append(root/'integrations/hermes/personal_aios/release_status.py')
        require(shutil.disk_usage(parent).free > GUARD + sum(p.stat().st_size for p in sources),'RESET_RETENTION_RUNTIME_CAPACITY')
        with tempfile.TemporaryDirectory(prefix='.reset-runtime-',dir=parent) as work:
            temporary=Path(work)/'runtime';temporary.mkdir(mode=0o700)
            manifest={'files':{}}
            for source in sources:
                name=source.relative_to(root).as_posix();destination=temporary/name
                destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
                shutil.copyfile(source,destination);destination.chmod(0o600)
                with destination.open('rb') as stream:
                    os.fsync(stream.fileno())
                manifest['files'][name]=file_hash(destination)
            from data_reset_manifest import save
            save(temporary/'manifest.json',manifest)
            for directory,_,_ in os.walk(temporary,topdown=False):
                sync_directory(directory)
            temporary.replace(target);sync_directory(parent)
    return str(target/'deploy/cloud/release.py')
