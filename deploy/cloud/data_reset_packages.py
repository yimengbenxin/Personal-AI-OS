"""Retain enabled package selections, with registry-compatible fresh recovery pins."""
import hashlib
import json
import os
from pathlib import Path

from data_reset_policy import RESET_ID, digest, require


def selections(owner):
    """Selection storage hashes JSON; CapabilityRegistry hashes the raw principal string."""
    directory = Path(owner)/'central-storage/capability-packages'
    if not directory.exists():
        return
    for path in sorted(directory.iterdir()):
        require(path.is_file() and not path.is_symlink(), 'RESET_PACKAGE_SELECTION_UNSAFE')
        state = json.loads(path.read_bytes())
        require(isinstance(state['principal'], str) and digest(state['principal']) == path.name
                and isinstance(state['versions'], list), 'RESET_PACKAGE_SELECTION_INVALID')
        key = hashlib.sha256(state['principal'].encode()).hexdigest()
        yield key, state


def pins(state):
    return [{'id':digest([RESET_ID,version['name'],version['digest']]),'name':version['name'],'before':None,
             'after':version,'reverted':False,'reason':RESET_ID,'state':'applied','principal':state['principal']}
            for version in state['versions']]


def history_rows(owner, path):
    history = json.loads(Path(path).read_bytes())
    require(isinstance(history, list), 'RESET_PACKAGE_HISTORY_INVALID')
    expected = next((pins(state) for key,state in selections(owner) if key == Path(path).stem), [])
    return sum(row not in expected for row in history)


def publish(owner, target, history):
    from data_reset_manifest import save
    save(target, history)
    if os.geteuid() == 0:
        info = Path(owner).stat()
        os.chown(target.parent, info.st_uid, info.st_gid)
        os.chown(target, info.st_uid, info.st_gid)


def seed(owner):
    registry = Path(owner)/'central-storage/capability-registry'
    for key,state in selections(owner):
        value = pins(state)
        if value:
            publish(owner, registry/(key+'.json'), value)


def verify(owner):
    registry = Path(owner)/'central-storage/capability-registry'
    for key,state in selections(owner):
        value = pins(state)
        if value:
            target = registry/(key+'.json')
            require(target.exists() and json.loads(target.read_bytes()) == value, 'RESET_PACKAGE_PINS_MISSING')


def rollback_available(registry, key, release):
    previous = release['before']
    if previous is None:
        return True
    relative = Path('versions')/key/previous['name']/previous['digest']
    # Producer-owned versions can be pruned after the cut; image built-ins are outside this tree.
    return (Path(previous['root']).parts[-5:] != ('capability-registry', *relative.parts)
            or (registry/relative).is_dir())


def restore(owner, displace):
    """Keep cut releases; pin only live selections without an available matching release."""
    registry = Path(owner)/'central-storage/capability-registry'
    for key,state in selections(owner):
        target = registry/(key+'.json')
        history = json.loads(target.read_bytes()) if target.exists() else []
        require(isinstance(history, list), 'RESET_PACKAGE_HISTORY_INVALID')
        missing = [pin for pin in pins(state) if not any(
            row['name'] == pin['name'] and row['after']['digest'] == pin['after']['digest']
            and not row['reverted'] and row['state'] != 'aborted'
            and rollback_available(registry, key, row) for row in history)]
        if missing:
            # Preserve the exact cut inode for normal restore checks and interrupted retries.
            displace(target, 'owner')
            publish(owner, target, history+missing)
