"""Actual media-family adapters keep public MCP evidence beside a complete receipt."""
import importlib.util
import json
import os
from pathlib import Path

from mcp.types import CallToolResult
import jsonschema
import pytest

ROOT=Path(__file__).parents[2]
source=Path(os.environ.get('PAIOS_OWNER_MAC_RECEIPTS',ROOT/'capability/packages/owner-mac/server/receipts.py'))
spec=importlib.util.spec_from_file_location('media_mac_receipts',source)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
SCHEMA=json.loads((ROOT/'capability/contracts/receipt.v1.schema.json').read_text())


def test_owner_mac_image_coordinates_and_media_attachment_are_preserved():
    raw={'_multimodal':True,'text_summary':'capture','content':[
        {'type':'text','text':'coordinate map: 2x2'},
        {'type':'image_url','image_url':{'url':'data:image/png;base64,AAAA'}}],
        'result':'MEDIA:/fixture/attachment.txt'}
    result=module.mcp_result('computer_use',{'action':'capture'},raw)
    jsonschema.validate(result['structuredContent'],SCHEMA);CallToolResult.model_validate(result)
    assert result['content'][1]=={'type':'image','mimeType':'image/png','data':'AAAA'}
    text=result['content'][0]['text']
    assert 'coordinate map: 2x2' in text and 'MEDIA:/fixture/attachment.txt' in text
    assert [block['type'] for block in result['content']].count('text')==1


def test_owner_mac_binary_read_is_a_public_resource_with_the_original_bytes():
    result=module.mcp_result('read',{}, {'path':'/fixture/document.bin','base64_content':'Zml4dHVyZQ==',
        'mime_type':'application/octet-stream','is_image':False,'content':'binary fixture'})
    CallToolResult.model_validate(result);jsonschema.validate(result['structuredContent'],SCHEMA)
    resource=next(block['resource'] for block in result['content'] if block['type']=='resource')
    assert resource=={'uri':'file:///fixture/document.bin','mimeType':'application/octet-stream','blob':'Zml4dHVyZQ=='}


def test_owner_mac_plain_legacy_media_is_preserved_at_the_owning_source():
    result=module.mcp_result('read',{},'MEDIA:/fixture/document.pdf')
    CallToolResult.model_validate(result);jsonschema.validate(result['structuredContent'],SCHEMA)
    assert 'MEDIA:/fixture/document.pdf' in result['content'][0]['text']


@pytest.mark.parametrize('kind',['resource','resource_link','audio'])
def test_owner_mac_public_mcp_media_survives_receipt_conversion(kind):
    blocks={'resource':{'type':'resource','resource':{'uri':'file:///fixture','text':'fixture'}},
        'resource_link':{'type':'resource_link','name':'fixture','uri':'file:///fixture'},
        'audio':{'type':'audio','mimeType':'audio/wav','data':'AAAA'}}
    result=module.mcp_result('computer_use',{'action':'capture'},{'ok':True,'content':[blocks[kind]]})
    CallToolResult.model_validate(result);assert blocks[kind] in result['content']
