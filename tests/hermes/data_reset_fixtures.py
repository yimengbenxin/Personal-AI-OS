"""Temporary stores, using shipped SQLite DDL, a sealed registry, original inodes and L5P1 cold packs."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/cloud'))
from data_reset_cold import Cold
from data_reset_policy import RESET_ID, OVERRIDE_KEY, EPOCH_PATH, encoded, digest


def write(root, path, value):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    target.write_bytes(value if isinstance(value, bytes) else value.encode())
    target.chmod(0o600)
    return target


class Stores:
    def __init__(self, directory):
        self.directory = directory
        self.roots = {name: str(directory / name) for name in ('owner', 'hermes', 'errands', 'models', 'projections', 'secrets', 'packages',
            'release_dumps','snapshot_spool','core','desktop_in','desktop_out','release_spool')}
        for path in self.roots.values():
            Path(path).mkdir(mode=0o700)
        root = lambda name: Path(self.roots[name])
        prepared = subprocess.run([sys.executable, str(ROOT / 'deploy/cloud/prepare-secrets.py'), '--staging',
            '--secrets-dir', self.roots['secrets'], '--public-host', 'synthetic.invalid', '--public-ipv4', '127.0.0.1'], capture_output=True)
        assert prepared.returncode == 0, 'synthetic secret preparation failed'
        for name in ('backup', 'state', 'acceptance', 'drive'):
            (directory / name).mkdir()
        self.settings = {'id': RESET_ID, 'roots': self.roots, 'state_dir': str(directory / 'state'),
            'capacity': {'reserve_bytes': 1024**3, 'reserve_inodes': 100000, 'margin_bytes': 2*1024**3},
            'baselines': [str(directory / 'acceptance')],
            'voice_command': ['node', str(ROOT / '01-product-half-finished/backend/services/personal-aios-integration/tools/data-reset-voiceprint.ts')]}
        self.cold = Cold({'directory': str(directory / 'drive')})
        write(directory / 'acceptance', 'accepted-case.json', b'{"protected":"synthetic baseline"}')
        write(root('owner'), EPOCH_PATH, encoded('0'*32))
        write(root('owner'), 'resources/iphone-pairing.v1.json', b'{"token":"synthetic-pairing"}')
        write(root('owner'), 'resources/local-owner.v1.json', b'{"owner":"synthetic-owner"}')
        write(root('release_dumps'),'releases/previous/.release/postgres-before.dump',b'synthetic-private-history-marker')
        write(root('release_dumps'),'releases/previous/protected-source.py',b'protected source baseline')
        write(root('snapshot_spool'),'snapshot-20261025T000000Z.age',b'synthetic encrypted old history')
        write(root('owner'), 'central-storage/voiceprints/'+OVERRIDE_KEY, b'{"enabled":false,"expires_at":null,"enabled_by_device":null,"failures":[{"device":"synthetic-guest","at":1}]}')
        write(root('owner'), 'central-storage/camera-capture-policy/'+'e'*64, b'{"policy":{"enabled":false}}')
        write(root('owner'), 'central-storage/principal-preferences/'+'f'*64, b'{"call_conversation_mode":"chat"}')
        write(root('projections'), 'current.json', b'{"model":"fixture-brain","api_key":"synthetic-credential-never-print"}')
        write(root('hermes'), 'config.yaml', b'model: fixture-brain\ntimezone: Asia/Shanghai\n')
        for role, path in [('hermes','skills/tool/SKILL.md'),('hermes','plugins/tool.py'),('packages','messaging/capability.json')]:
            write(root(role), path, b'synthetic capability retained byte for byte')
        (root('hermes')/'plugins/image-code').symlink_to('/opt/paios/integrations/hermes/personal_aios')
        write(root('hermes'),'workshop/config.yaml',b'model: fixture-brain\n')
        write(root('hermes'),'workshop/skills/workshop/tool/SKILL.md',b'synthetic own published skill')
        write(root('hermes'),'platforms/pairing/telegram-approved.json',b'{"synthetic-owner":true}')
        write(root('hermes'),'platforms/pairing/telegram-pending.json',b'{"synthetic-guest":"old request"}')
        write(root('hermes'),'mcp-tokens/tool.json',b'{"token":"synthetic-credential-never-print"}')
        write(root('hermes'),'.credentials.json',b'{"token":"synthetic-credential-never-print"}')
        write(root('hermes'),'secrets/native.key',b'synthetic-credential-never-print')
        kept = write(root('hermes'),'skills/hardlink.txt',b'synthetic shared inode')
        linked = root('owner')/'central-storage/stream-revisions/shared'; linked.parent.mkdir(parents=True)
        os.link(kept,linked)
        os.link(linked,linked.with_name('clear-twin'))
        principal=digest('synthetic-owner')
        package={'name':'synthetic-tool','version':'1','digest':'a'*64,'root':str(root('owner')/'central-storage/capability-registry/versions/tool'),
                 'manifest':{'name':'synthetic-tool'}}
        write(root('owner'),'central-storage/capability-registry/versions/tool/plugin.json',encoded(package['manifest']))
        write(root('owner'),'central-storage/capability-packages/'+principal,encoded({'principal':'synthetic-owner','versions':[package]}))
        history_key=hashlib.sha256(b'synthetic-owner').hexdigest()
        release={'id':'synthetic-release','name':package['name'],'before':None,'after':package,
                 'principal':'synthetic-owner','reason':'synthetic-private-history-marker','state':'applied','reverted':False}
        write(root('owner'),'central-storage/capability-registry/'+history_key+'.json',encoded([release]))
        write(root('owner'),'central-storage/capability-registry/old.candidate.json',b'synthetic-private-history-marker')
        write(root('hermes'),'workshop/sessions/old.jsonl',b'synthetic-private-history-marker')
        for role, path in [('core','USER.md'),('desktop_in','received.pdf'),('desktop_out','completed.txt'),('release_spool','status/old.json')]:
            write(root(role),path,b'synthetic-private-history-marker')
        for path in ('sessions/owner.jsonl', 'sessions/guest.jsonl', 'MEMORY.md', 'USER.md', 'memory/L1.json', 'memories/L2.md',
                     'memories/L4.md', 'cron/jobs.json', 'logs/call.log', 'response_store.db', 'runs_idempotency.db'):
            write(root('hermes'), path, b'synthetic-private-history-marker')
        state = root('hermes') / 'state.db'
        from hermes_state import SessionDB
        with SessionDB(state) as db:
            for n, source in enumerate(('owner-phone','guest-phone','owner-mac','guest-glasses','owner-watch','owner-call')):
                db.create_session(str(n),source)
                db.append_message(str(n),'user','synthetic-private-history-marker')
        for name in ('objects','manifests','processed-events','output-journal','delivery-ledger','activity-cards','capability-ledger','people',
                     'guest-profiles','audio-consumer-results','voice-transcripts','session-finals','meeting-notes','raw-ingress','runtime-events'):
            write(root('owner'), f'central-storage/{name}/' + 'b'*64, b'synthetic-private-history-marker')
        for path in ('core-profile/USER.md', 'state/call-turns/audio.pcm', 'state/errand-observation.json', 'desktop-inbox/received.pdf'):
            write(root('owner'), path, b'synthetic-private-history-marker')
        write(root('errands'), 'job.request', b'{"owner":"synthetic guest","task":"history"}')
        write(root('errands'), 'job.done', b'{"result":"history"}')
        write(root('owner'), 'central-storage/effect-consents/'+'c'*64, encoded({'kind':'send','recipient':'synthetic owner','confirmed_at':'2026-10-25'}))
        write(root('owner'), 'central-storage/effect-consents/'+'d'*64, encoded({'kind':'delete','run_id':'synthetic history'}))
        for folder, filename, source in [('timeline','timeline.sqlite','timeline.ts'),('care','care.sqlite','care/authority.ts')]:
            target = root('owner') / 'central-storage' / folder / filename
            target.parent.mkdir()
            with sqlite3.connect(target) as db:
                code=(ROOT/'01-product-half-finished/backend/services/personal-aios-integration/src'/source).read_text()
                db.executescript(code.split('const DDL=',1)[1].split('`',1)[1].split('`;',1)[0])
                for principal in ('owner','guest'):
                    if folder == 'timeline':
                        db.execute("INSERT INTO items(principal_id,item_id,kind,via,text,at_ms,source_class) VALUES(?,?,'owner','text',?,1,'iphone')",
                                   (principal,principal,'synthetic-private-history-marker'))
                    else:
                        db.execute('INSERT INTO events(care_id,principal_id,device_id,at_ms) VALUES(?,?,?,1)',(principal,principal,'phone'))
                        db.execute('INSERT INTO timeline VALUES(?,1,?)',(principal,'synthetic-private-history-marker'))
        payment = root('owner') / 'central-storage/payment/payment.sqlite'
        payment.parent.mkdir()
        ddl = (ROOT / '01-product-half-finished/backend/services/personal-aios-integration/src/payment/store.ts').read_text().split('const DDL=`',1)[1].split('`;',1)[0]
        with sqlite3.connect(payment) as db:
            db.executescript(ddl)
            db.execute("INSERT INTO meta VALUES('schema','paios.payment-store.v1')")
            db.execute("INSERT INTO meta VALUES('environment','production')")
            db.execute("INSERT INTO meta VALUES('payment-context:old','synthetic-private-history-marker')")
            db.execute("INSERT INTO policy VALUES('owner',1,1,0,'{}',NULL,1)")
            db.execute("INSERT INTO locks VALUES('phone','owner','phone',1,30,1)")
            db.execute("INSERT INTO device_keys VALUES('phone','device','owner','synthetic-key',1,NULL)")
            db.execute("INSERT INTO events(at_ms,principal_id,kind,actor,data,prev_hash,hash) VALUES(1,'owner','history','owner','{}','a','b')")
        payload = b'synthetic raw cold audio and video' * 200
        compressed, raw_hash = gzip.compress(payload,mtime=0), hashlib.sha256(payload).hexdigest()
        header = gzip.compress(encoded({'schema':'paios.cold.v1','items':[{'namespace':'objects','key':raw_hash,'hash':raw_hash,'size':len(payload),'offset':0,'block':0}],
            'blocks':[{'codec':'gzip','offset':0,'size':len(compressed),'decoded':len(payload),'hash':hashlib.sha256(compressed).hexdigest()}]}),mtime=0)
        pack = b'L5P1' + struct.pack('!I',len(header)) + header + compressed
        pack_hash = hashlib.sha256(pack).hexdigest()
        write(directory / 'drive', pack_hash+'.l5pack', pack)
        write(directory / 'drive', 'backups/legacy.l5pack', pack)
        write(directory / 'drive', 'originals/2026-10-25/synthetic.jpg', b'synthetic photo')
        index = root('owner') / 'central-storage/cold.sqlite'
        with sqlite3.connect(index) as db:
            db.executescript('CREATE TABLE locations(namespace TEXT,key TEXT,pack TEXT,size INTEGER,hash TEXT);CREATE TABLE packs(key TEXT,size INTEGER);')
            db.execute('INSERT INTO packs VALUES(?,?)',(pack_hash,len(pack)))
            db.execute('INSERT INTO locations VALUES(?,?,?,?,?)',('objects',raw_hash,pack_hash,len(payload),raw_hash))
        result = self.node(False)
        assert result['owner_enrolled']

    def node(self, verify):
        result = subprocess.run(['node',str(ROOT/'tests/hermes/data_reset_seed.ts')],input=json.dumps({'roots':self.roots,'verify':verify}),
                                capture_output=True,text=True)
        assert result.returncode == 0, 'synthetic registry/model settings worker failed: ' + result.stderr[-1200:]
        return json.loads(result.stdout)
