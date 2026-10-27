"""Read the existing revision authority and its projections; never open the model vault or keys."""
import json
import importlib.util
from pathlib import Path
import subprocess
import sys

from data_reset_policy import digest, require
from data_reset_sqlite import connect


def snapshot(settings, scratch):
    roots = {k: Path(v) for k, v in settings['roots'].items()}
    authority = roots.get('models', roots['owner']/'central-storage/model-settings')/'model-settings.sqlite3'
    if not authority.exists():
        return None  # No revision authority: every keep object remains byte-exact.
    if settings.get('model_settings_command'):
        result = subprocess.run(settings['model_settings_command'], input=json.dumps({
            'roots': settings['roots'], 'scratch': str(scratch)}), text=True, capture_output=True, check=True)
        return json.loads(result.stdout)
    return read(roots, authority, scratch)


def read(roots, authority, scratch):
    with connect(authority, scratch) as db:
        require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'RESET_MODEL_SETTINGS_CORRUPT')
        require(db.execute("SELECT value FROM meta WHERE key='schema'").fetchone() == ('paios.model-settings.v1',),
                'RESET_MODEL_SETTINGS_SCHEMA')
        environment = db.execute("SELECT value FROM meta WHERE key='environment'").fetchone()[0]
        revisions = {r[0] for r in db.execute('SELECT revision FROM model_revisions')}
        groups = {name: {'desired': desired, 'effective': effective} for name, desired, effective in
                  db.execute('SELECT name,desired,effective FROM model_groups')}
    require(set(groups) == {'brain', 'build'}, 'RESET_MODEL_SETTINGS_GROUPS')
    require(all(g[k] in revisions | {0} for g in groups.values() for k in ('desired', 'effective')), 'RESET_MODEL_SETTINGS_REVISION_UNKNOWN')
    state = {'environment': environment, 'revision': max(revisions, default=0), 'groups': groups,
             'managed': [str(authority)+suffix for suffix in ('', '-wal', '-shm')], 'projections': {}, 'configs': {}}
    directory = roots.get('projections', roots['owner']/'model-projections')
    documents = {}

    def projection(path):
        value = json.loads(path.read_text())
        require(value['environment_id'] == environment and value['group'] in groups
                and type(value['revision']) is int and value['revision'] in revisions | {0}, 'RESET_MODEL_SETTINGS_PROJECTION')
        state['managed'].append(str(path))
        state['projections'][str(path)] = {k: value[k] for k in ('group', 'profile', 'revision')}
        return value

    for path in sorted(directory.glob('revisions/*/*.json')):
        value = projection(path)
        require(path.parent.name == str(value['revision']) and path.stem == value['profile'], 'RESET_MODEL_SETTINGS_PROJECTION')
        documents[value['group'], value['profile'], value['revision']] = value
    for name, group in (('current.json', 'brain'), ('build-current.json', 'build')):
        path = directory/name
        if path.exists():
            value = projection(path)
            require(value['group'] == group and value == documents.get((group, value['profile'], value['revision'])),
                    'RESET_MODEL_SETTINGS_PROJECTION')
            state['projections'][str(path)]['published'] = True
    # Native ACK installs the same immutable projection and rewrites config.yaml's transport fields.
    # Use the native producer's field ownership; retain an exact canonical digest of all other settings.
    spec = importlib.util.spec_from_file_location('reset_model_transport', Path(__file__).resolve().parents[2]/
                                                  'integrations/hermes/personal_aios/model_transport.py')
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    fields = transport.TRANSPORT_FIELDS
    import yaml
    for home, group in ((roots['hermes'], 'brain'), (roots['hermes']/'workshop', 'build')):
        for path in sorted((home/'model-settings/revisions').glob('*/*.json')):
            value = projection(path)
            require(path.parent.name == str(value['revision']) and path.stem == value['profile']
                    and value == documents.get((group, value['profile'], value['revision'])), 'RESET_MODEL_SETTINGS_PROJECTION')
        path = home/'config.yaml'
        if not path.exists():
            continue
        config = yaml.safe_load(path.read_text())
        if 'model_settings' not in config:
            continue
        meta = config['model_settings']
        value = documents.get((group, meta['profile'], meta['revision']))
        require(value is not None and meta == {k: value[k] for k in ('environment_id', 'profile', 'revision', 'group')}
                and {k: v for k, v in config.items() if k in fields} == value['config'],
                'RESET_MODEL_SETTINGS_PROJECTION')
        source = config['secrets']['personal_aios']
        require(set(config['secrets']) == {'environment', 'personal_aios'} and config['secrets']['environment'] == 'profile'
                and set(source) == {'enabled', 'projection'} and source['enabled'] == value['configured'] and source['projection'].endswith(
            '/model-settings/revisions/'+str(meta['revision'])+'/'+meta['profile']+'.json'), 'RESET_MODEL_SETTINGS_PROJECTION')
        state['managed'].append(str(path))
        state['configs'][str(path)] = digest({k: v for k, v in config.items()
                                              if k not in fields | {'model_settings', 'secrets'}})
        state['projections'][str(path)] = {'group': group, 'profile': meta['profile'], 'revision': meta['revision'], 'published': True}
    return state


def rollback_hashes(before, current):
    """Only a coherent, non-regressing authority may replace its own pre-reset bytes."""
    from data_reset_inventory import keep_hashes
    old, new = before.get('model_settings'), current.get('model_settings')
    if old is None:
        require(new is None, 'RESET_ROLLBACK_KEEP_DRIFT')
        return keep_hashes(before), keep_hashes(current)
    require(new is not None and new['environment'] == old['environment'] and new['revision'] >= old['revision'],
            'RESET_MODEL_SETTINGS_REVISION_REGRESSED')
    for name, group in new['groups'].items():
        require(group['desired'] == group['effective'], 'RESET_MODEL_SETTINGS_NOT_EFFECTIVE')
        require(old['groups'][name]['desired'] <= group['desired'] <= new['revision']
                and old['groups'][name]['effective'] <= group['effective'], 'RESET_MODEL_SETTINGS_REVISION_REGRESSED')
    require(old['projections'].keys() <= new['projections'].keys(), 'RESET_MODEL_SETTINGS_PROJECTION')
    for path, projection in new['projections'].items():
        if projection.get('published'):
            require(projection['revision'] == new['groups'][projection['group']]['effective'], 'RESET_MODEL_SETTINGS_NOT_EFFECTIVE')
        if path in old['projections']:
            prior = old['projections'][path]
            require(projection['group'] == prior['group'] and projection['profile'] == prior['profile']
                    and projection['revision'] >= prior['revision'], 'RESET_MODEL_SETTINGS_REVISION_REGRESSED')

    def strict(report, model):
        hashes = keep_hashes(report)
        for row in report['files']:
            path = str(Path(report['roots'][row['root']])/row['path'])
            if row['action'] == 'keep' and path in model['managed']:
                hashes.pop(row['root']+'/'+row['path'])
        # The native config is mixed: unrelated product settings still cannot drift.
        hashes['model-settings/native-product-settings'] = model['configs']
        return hashes
    return strict(before, old), strict(current, new)


if __name__ == '__main__':
    request = json.load(sys.stdin)
    print(json.dumps(snapshot({'roots': request['roots']}, request['scratch'])))
