"""Storage identity publication survives process loss before receipt creation."""
import json
from pathlib import Path
import subprocess
import sys

import pytest

from test_data_reset_review import ROOT, settings_at
import data_reset
import data_reset_manifest as journal
from data_reset_policy import RESET_ID


CRASH = '''import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import data_reset,data_reset_manifest as journal
real_open=journal.os.open
def stop(path,*args,**kwargs):
 descriptor=real_open(path,*args,**kwargs)
 if Path(path).name.startswith('.rq102-storage-id'):os._exit(102)
 return descriptor
journal.os.open=stop
data_reset.run(json.loads(sys.argv[2]),'quarantine')
'''


def test_identity_open_crash_allows_plain_quarantine_retry_and_rollback(tmp_path):
    settings = settings_at(tmp_path)
    child = subprocess.run([sys.executable,'-c',CRASH,str(ROOT/'deploy/cloud'),json.dumps(settings)],
                           capture_output=True, text=True)
    assert child.returncode == 102, child.stderr
    assert not (tmp_path/'state'/('data-reset-'+RESET_ID+'.json')).exists()
    scratch = list(tmp_path.rglob('.rq102-storage-id-*.tmp'))
    assert len(scratch) == 1 and scratch[0].stat().st_size == 0
    assert not list(tmp_path.rglob('.rq102-storage-id'))
    assert (tmp_path/'hermes/MEMORY.md').read_text() == 'cut history'

    cut = data_reset.run(settings,'quarantine')
    assert cut['state'] == 'quarantined'
    assert cut['verification']['manifest_complete']
    receipt = journal.load(settings,cut['receipt'])
    assert all(len(journal.storage_identity(row['path'])) == 32 for row in receipt['storage'])
    data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert (tmp_path/'hermes/MEMORY.md').read_text() == 'cut history'


def test_empty_identity_bound_to_receipt_still_refuses_retry_and_rollback(tmp_path):
    settings = settings_at(tmp_path)
    cut = data_reset.run(settings,'quarantine')
    receipt = journal.load(settings,cut['receipt'])
    marker = Path(receipt['storage'][0]['path'])/'.rq102-storage-id'
    marker.write_text('')
    for action in ('quarantine','rollback'):
        with pytest.raises(ValueError,match='^RESET_QUARANTINE_MOUNT_CHANGED$'):
            data_reset.run(settings,action,receipt_path=cut['receipt'])
        assert marker.read_bytes() == b''
    assert not (tmp_path/'hermes/MEMORY.md').exists()
