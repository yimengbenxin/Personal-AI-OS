"""Root cloud init followed by the unchanged native backup writer as uid 10000."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import traceback
from unittest.mock import patch

root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('cloud_init', root / 'deploy/cloud/hermes-init.py')
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)

with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    home.chmod(0o755)
    os.chown(home, 10000, 10000)  # upstream s6 setup precedes the product hook
    os.environ.update(HERMES_HOME=str(home), PAIOS_INTEGRATION_PORT='19661',
        PAIOS_PHONE_PROVIDER='off', PAIOS_WORKSHOP_HOST='fixture', PAIOS_STAGE='production',
        PAIOS_DEPLOYMENT='cloud', PAIOS_PRODUCT_CONFIG=str(home / 'gateway.json'))
    (home / 'gateway.json').write_text(json.dumps({'time_zone': 'Asia/Taipei'}))
    cloud.ACCESS = home / 'access'
    cloud.ACCESS.mkdir()
    cloud.SECRETS = home / 'secrets'
    cloud.SECRETS.mkdir()
    for group, profile, variable in [('brain', 'owner', 'PAIOS_MODEL_SETTINGS_PROJECTION'),
                                     ('build', 'workshop', 'PAIOS_MODEL_SETTINGS_BUILD_PROJECTION')]:
        path = home / f'{group}.json'
        path.write_text(json.dumps({'environment_id': 'fixture', 'profile': profile, 'revision': 0,
            'group': group, 'configured': False, 'config': {'model': {'enabled': False},
            'fallback_providers': []}, 'credentials': []}))
        os.environ[variable] = str(path)
    product = root / 'deploy/cloud/hermes-product-config.yaml'
    cloud.seed_config(home, product)
    if sys.argv[2] == 'imported':
        (home / 'backups/config').mkdir(parents=True)
        (home / 'backups/config/config.yaml.good.20000101-000000').write_bytes((home / 'config.yaml').read_bytes())
    cloud.initialize(home, root / 'integrations/hermes/personal_aios', product)
    # Config imports in the root hook create native good backups, including on a fresh home.
    backups = home / 'backups/config'
    assert backups.is_dir()
    assert list(backups.iterdir())
    child = os.fork()
    if child == 0:
        try:
            os.setgroups([])
            os.setgid(10000)
            os.setuid(10000)
            from hermes_cli.config_backups import backup_config
            config = home / 'config.yaml'
            config.write_bytes(config.read_bytes() + b'\n# runtime edit\n')
            with patch('hermes_cli.config_backups.time.strftime', return_value='20990101-000000'):
                saved = backup_config(config, 'good')
            assert saved is not None and saved.read_bytes() == config.read_bytes()
            assert saved.stat().st_uid == 10000
            assert backup_config(config, 'good') is None  # last-good comparison remains readable
        except BaseException:
            traceback.print_exc()
            os._exit(1)
        os._exit(0)
    assert os.waitpid(child, 0)[1] == 0
    assert all(path.stat().st_uid == path.stat().st_gid == 10000
               for path in [backups.parent, backups, *backups.iterdir()])
