"""Voice rollback uses the producer's migration and monotonic revision after real live writes."""
import base64
import json
from pathlib import Path
import subprocess
import struct
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud'))
import data_reset
import data_reset_manifest as journal
from data_reset_inventory import inventory, keep_hashes, public_plan, voice
from data_reset_policy import RESET_ID, VOICE_KEY


@pytest.fixture
def voice_store(tmp_path):
    roots = {name:str(tmp_path/name) for name in ('owner','hermes','errands','secrets')}
    for root in roots.values():
        Path(root).mkdir()
    (tmp_path/'state').mkdir()
    (tmp_path/'hermes/MEMORY.md').write_text('cut history')
    settings = dict(id=RESET_ID,roots=roots,state_dir=str(tmp_path/'state'),
        capacity={'reserve_bytes':1024**3,'reserve_inodes':100000,'margin_bytes':2*1024**3},voice_command=[
        'node',str(ROOT/'01-product-half-finished/backend/services/personal-aios-integration/tools/data-reset-voiceprint.ts')])
    path = tmp_path/'owner/central-storage/voiceprints'/VOICE_KEY
    path.parent.mkdir(parents=True)
    return settings, path


@pytest.mark.parametrize('schema,assistant,enrolled', [('v1',True,False),('v1',False,False),('v1',True,True),('v2',True,False)])
def test_real_assistant_write_then_rollback_preserves_live_revision(voice_store, schema, assistant, enrolled):
    settings, path = voice_store
    owner = None
    if enrolled:
        embedding = base64.b64encode(struct.pack('<16f',1,*([0]*15))).decode()
        at = '2026-10-26T00:00:00.000Z'
        owner = dict(model=dict(id='synthetic',sha256='a'*64,dim=16),centroid=embedding,
            samples=[dict(embedding=embedding,speech_ms=2500,added_at=at) for _ in range(5)],
            enrolled_at=at,updated_at=at,consistency=dict(min=1,mean=1),verified_threshold=0.65)
    path.write_text(json.dumps(dict(schema='paios.voiceprint.registry.'+schema,revision=9,next_number=1,
        clusters=[],**({'assistant':[]} if assistant else {}),
        **({'owner':owner} if schema == 'v1' else {'owner_sets':[]}))))
    before = voice(path,settings)
    cut = data_reset.run(settings,'quarantine')
    subprocess.run(['node',str(ROOT/'tests/hermes/data_reset_voice_review_fixture.ts'),
                    str(Path(settings['roots']['owner'])/'central-storage')],capture_output=True,text=True,check=True)
    live_doc = json.loads(path.read_text())
    assert live_doc['schema'] == 'paios.voiceprint.registry.v2'
    assert live_doc['revision'] > 9 and len(live_doc['assistant']) == 1
    live = inventory(settings)
    assert 'metadata' not in json.dumps(public_plan(live))
    if schema == 'v2':
        assert before['owner_sha256'] == voice(path,settings)['owner_sha256']
    else:
        assert before['metadata']['owner_sha256'] == voice(path,settings)['metadata']['owner_sha256']
    result = data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert result['state'] == 'restored'
    restored = json.loads(path.read_text())
    assert restored['schema'] == 'paios.voiceprint.registry.v2'
    assert restored['revision'] == max(9,live_doc['revision'])+1
    assert restored['owner_sets'] == live_doc['owner_sets']
    assert restored['assistant'] == []
    assert keep_hashes(inventory(settings)) == keep_hashes(live)
    receipt = journal.load(settings,cut['receipt'])
    entry = next(row for row in receipt['entries'] if row['action'] == 'voiceprint')
    assert entry.get('rollback_stage')
    assert json.loads(Path(entry['quarantine']).read_text())['revision'] == 9


@pytest.mark.parametrize('schema', ['v1','v2'])
def test_fresh_projection_revision_also_advances_on_rollback(voice_store, schema):
    settings, path = voice_store
    doc = dict(schema='paios.voiceprint.registry.'+schema,revision=9,next_number=1,clusters=[],assistant=[],
               **({'owner':None} if schema == 'v1' else {'owner_sets':[]}))
    path.write_text(json.dumps(doc))
    cut = data_reset.run(settings,'quarantine')
    assert json.loads(path.read_text())['revision'] == 10
    data_reset.run(settings,'rollback',receipt_path=cut['receipt'])
    assert json.loads(path.read_text()) == {**doc,'revision':11}


@pytest.mark.parametrize('key_available', [True, False])
def test_plaintext_cut_and_producer_encrypted_live_rollback(tmp_path, key_available):
    result = subprocess.run(['node', str(ROOT/'tests/hermes/data_reset_voice_cipher_fixture.ts'),
                             str(tmp_path), 'available' if key_available else 'missing'],
                            capture_output=True, text=True, check=True)
    observed = json.loads(result.stdout.splitlines()[-1])
    assert observed['producer_sealed'] is True
    assert observed['producer_revision'] > 9
    if key_available:
        assert observed['worker_exit'] == 0
        assert 'error' not in observed['result']
        assert observed['restored_sealed'] is True
        assert observed['restored'] == dict(schema='paios.voiceprint.registry.v2',
            revision=observed['producer_revision']+1, next_number=1, owner_sets=[],
            clusters=[], assistant=[], recognition_hints=True)
    else:
        assert observed['worker_exit'] == 1
        assert observed['result']['error'] == 'RESET_ROLLBACK_MIXED_UNMERGEABLE_VOICEPRINT'
        assert observed['restored_sealed'] is False
        assert observed['restored']['revision'] == 9
    assert not (tmp_path/'absent-key').exists()
