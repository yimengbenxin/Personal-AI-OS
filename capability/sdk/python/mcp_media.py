"""Preserve public MCP media and legacy attachment text at the package boundary."""
from copy import deepcopy
import json


def content(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return [{'type': 'text', 'text': line} for line in raw.splitlines() if line.startswith('MEDIA:')]
    if not isinstance(raw, dict):
        return []
    blocks = []
    source = raw.get('content')
    for item in source if isinstance(source, list) else []:
        if not isinstance(item, dict):
            continue
        if item.get('type') in {'text', 'image', 'audio', 'resource', 'resource_link'}:
            blocks.append(deepcopy(item))
        elif item.get('type') == 'image_url':
            url = item['image_url']['url']
            if url.startswith('data:'):
                header, data = url.split(',', 1)
                blocks.append({'type': 'image', 'mimeType': header[5:].split(';')[0], 'data': data})
            else:
                blocks.append({'type': 'resource_link', 'name': 'image', 'uri': url})
    if isinstance(raw.get('result'), str):
        blocks.extend(content(raw['result']))
    return blocks
