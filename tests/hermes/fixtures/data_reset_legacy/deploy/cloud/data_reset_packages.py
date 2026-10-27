"""Retain enabled package bytes/selections, replace registration history with fresh configuration pins."""
import json
import os
from pathlib import Path

from data_reset_policy import RESET_ID, digest, require


def pins(owner, name):
    selection=Path(owner)/'central-storage/capability-packages'/name
    if not selection.exists():
        return []
    require(selection.is_file() and not selection.is_symlink(),'RESET_PACKAGE_SELECTION_UNSAFE')
    state=json.loads(selection.read_bytes())
    require(digest(state['principal']) == name and isinstance(state['versions'],list),'RESET_PACKAGE_SELECTION_INVALID')
    return [{'id':digest([RESET_ID,version['name'],version['digest']]),'name':version['name'],'before':None,
             'after':version,'reverted':False,'reason':RESET_ID,'state':'applied','principal':state['principal']}
            for version in state['versions']]


def history_rows(owner,path):
    history=json.loads(Path(path).read_bytes())
    require(isinstance(history,list),'RESET_PACKAGE_HISTORY_INVALID')
    return 0 if history == pins(owner,Path(path).stem) else len(history)


def seed(owner):
    from data_reset_manifest import save
    root=Path(owner)
    selections=root/'central-storage/capability-packages'
    if not selections.exists():
        return
    registry=root/'central-storage/capability-registry'
    registry.mkdir(parents=True,exist_ok=True,mode=0o700)
    for selection in sorted(selections.iterdir()):
        require(selection.is_file() and not selection.is_symlink(),'RESET_PACKAGE_SELECTION_UNSAFE')
        value=pins(root,selection.name)
        if value:
            target=registry/(selection.name+'.json')
            save(target,value)
            if os.geteuid() == 0:
                info=root.stat();os.chown(registry,info.st_uid,info.st_gid);os.chown(target,info.st_uid,info.st_gid)


def verify(owner):
    root=Path(owner)
    selections=root/'central-storage/capability-packages'
    if selections.exists():
        for selection in selections.iterdir():
            value=pins(root,selection.name)
            if value:
                target=root/'central-storage/capability-registry'/(selection.name+'.json')
                require(target.exists() and json.loads(target.read_bytes()) == value,'RESET_PACKAGE_PINS_MISSING')
