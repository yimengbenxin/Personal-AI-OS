"""Resolve only synthetic Compose mounts; never invoke a Docker daemon or a remote archive."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from data_reset_fixtures import Stores
import data_reset_host
from data_reset_policy import validate


@pytest.mark.parametrize('bind_driver',[False,True])
@pytest.mark.parametrize('directory_secret_mount',[False,True])
def test_compose_authority_includes_nested_stores_and_preserves_cold_scope(tmp_path,monkeypatch,directory_secret_mount,bind_driver):
    (tmp_path/'stores').mkdir()
    stores=Stores(tmp_path/'stores')
    mounts={}
    stubs=tmp_path/'empty-mountpoints'; stubs.mkdir()
    def bind(role,target):
        return {'type':'bind','source':stores.roots[role],'target':target}
    def volume(role,target):
        stub=stubs/role; stub.mkdir()
        mounts[role]=str(stub) if bind_driver else stores.roots[role]
        return {'type':'volume','source':role,'target':target}
    secrets=Path(stores.roots['secrets'])
    config=tmp_path/'cloud.json'
    config.write_text(json.dumps({'archive_tiering':{'cold':{'url':'http://cold-webdav:5244/dav/scoped-l5',
        'username':'synthetic','password_file':'${PAIOS_SECRET_ROOT}/cold-webdav.password'}}}))
    pgroot=tmp_path/'postgres';pgroot.mkdir()
    baselines=[]
    for name in ('weights','source','snapshots','ssh','access'):
        path=tmp_path/name;path.mkdir();baselines.append(str(path))
    gateway=[bind('owner','/var/lib/paios'),volume('errands','/var/lib/paios/state/errands'),
        volume('models','/var/lib/paios/central-storage/model-settings'),bind('projections','/var/lib/paios/model-projections'),
        volume('core','/var/lib/paios/core-profile/memories'),volume('desktop_in','/var/lib/paios/desktop-in'),
        volume('desktop_out','/var/lib/paios/desktop-out'),{'type':'bind','source':baselines[0],'target':'/opt/models'},
        {'type':'bind','source':str(config),'target':'/etc/paios/cloud.json'}]
    gateway += ([bind('secrets','/run/secrets')] if directory_secret_mount else
        [{'type':'bind','source':str(secrets/name),'target':'/run/secrets/'+name}
         for name in ('model-settings-master.key','cold-webdav.password')])
    definition={'services':{'gateway':{'image':'synthetic-image','volumes':gateway,'environment':{'PAIOS_SECRET_ROOT':'/run/secrets'}},
        'hermes':{'volumes':[volume('hermes','/opt/data'),bind('release_spool','/srv/release-spool'),
            {'type':'bind','source':baselines[4],'target':'/run/workshop-access'}]},
        'workshop':{'volumes':[{'type':'bind','source':path,'target':target} for path,target in
            zip(baselines[1:4],('/workshop','/srv/workshop-snapshots','/var/lib/workshop-ssh'))]},
        'postgres':{'volumes':[{'type':'bind','source':str(pgroot),'target':'/var/lib/postgresql'}]},
        'cold-webdav':{'ports':[{'target':5244,'published':'15244','host_ip':'127.0.0.1'}]}},
        'volumes':{role:{'name':role,**({'driver_opts':{'type':'none','o':'bind','device':stores.roots[role]}} if bind_driver else {})} for role in mounts}}
    def inspect(args,**kwargs):
        assert args[:3]==['docker','volume','inspect']
        return SimpleNamespace(stdout=mounts[args[-1]])
    state=tmp_path/'release-state';state.mkdir()
    release_root=tmp_path/'releases';release_root.mkdir()
    spec={**stores.settings,'snapshot_settings':str(tmp_path/'absent-snapshot-config')}
    host=SimpleNamespace(config={'data_reset':spec},suffix='',root=release_root,
        definition=lambda release:definition,lock_path=lambda:state/'release.lock')
    with monkeypatch.context() as mounted:
        mounted.setattr(data_reset_host.subprocess,'run',inspect)
        result=data_reset_host.settings(host,release_root)
    validate(result)
    for role in ('owner','hermes','errands','models','projections','secrets','core','desktop_in','desktop_out','release_spool'):
        assert result['roots'][role]==stores.roots[role]
    assert result['cold']['url']=='http://127.0.0.1:15244/dav/scoped-l5'
    assert result['cold']['password_file']==str(secrets/'cold-webdav.password')
    assert result['baselines'][1:]==baselines
    assert '--network' in result['voice_command'] and 'none' in result['voice_command']

    if bind_driver:
        # Quarantine actual OUT/errand/native data, even when Docker's stopped mountpoints are empty.
        import data_reset
        from data_reset_inventory import inventory, keep_hashes
        result['voice_command']=stores.settings['voice_command']
        before=inventory(result)
        applied=data_reset.run(result,'quarantine')
        assert applied['verification']['clear_verified']
        assert keep_hashes(inventory(result))==keep_hashes(before)
        assert not list(Path(stores.roots['desktop_out']).iterdir())
        assert all(not list(p.iterdir()) for p in stubs.iterdir())
        assert data_reset.run(result,'rollback',receipt_path=applied['receipt'])['inode_counts_verified']
        assert (Path(stores.roots['desktop_out'])/'completed.txt').is_file()
