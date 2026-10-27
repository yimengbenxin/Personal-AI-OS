"""Send kind/recipient declarations are an owner baseline; a package version alone is not."""
import json


def changed_send_policies(git, repo, base, commit, changed):
    protected = []
    for path in changed:
        if not (path.startswith('capability/packages/') and path.endswith('/plugin.json')):
            continue

        def policy(revision):
            if not git(repo, 'ls-tree', revision, '--', path):
                return {}
            manifest = json.loads(git(repo, 'show', revision + ':' + path, text=True))
            tools = manifest.get('extensions', {}).get('ai.yimi.capability', {}).get('tools', {})
            return {name: tool['send_consent'] for name, tool in tools.items() if 'send_consent' in tool}

        if policy(base) != policy(commit):
            protected.append(path)
    return protected
