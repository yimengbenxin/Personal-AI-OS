"""Synthetic workspace effect and public MCP media; no external services."""
import asyncio
import base64
import json
import os
from pathlib import Path
from io import BytesIO
from PIL import Image

from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, ListToolsResult, Tool
from capability.sdk.python.yimi_receipt import succeeded, effect, to_mcp_result

schema=json.loads((Path(__file__).resolve().parents[3]/'capability/contracts/receipt.v1.schema.json').read_text())


async def listing(context, params):
    return ListToolsResult(tools=[Tool(name='effect',description='Commit a synthetic workspace fixture.',
        inputSchema={'type':'object','properties':{'label':{'type':'string'}},'required':['label'],'additionalProperties':False},outputSchema=schema)])


async def calling(context, params):
    label=params.arguments['label']
    if os.environ.get('U0_MODE')=='recovery':
        Path(os.environ['U0_READY']).touch()
        while not Path(os.environ['U0_RELEASE']).exists():await asyncio.sleep(.01)
    with Path(os.environ['U0_EFFECT_LOG']).open('a') as stream:
        stream.write(json.dumps({'label':label})+'\n')
    result=to_mcp_result(succeeded(effects=[effect('workspace',label,'fixture','service_ack','synthetic committed effect')]))
    if os.environ.get('U0_MEDIA')=='1':
        attachment=Path(os.environ['HERMES_HOME'])/'attachment.txt';attachment.write_text('synthetic attachment')
        result['content'][0]['text']+='\nMEDIA:'+str(attachment)
        pixels=BytesIO();Image.new('RGB',(2,2),(1,2,3)).save(pixels,format='PNG')
        result['content'].extend([
            {'type':'image','mimeType':'image/png','data':base64.b64encode(pixels.getvalue()).decode()},
            {'type':'resource','resource':{'uri':attachment.as_uri(),'mimeType':'application/octet-stream',
                'blob':base64.b64encode(attachment.read_bytes()).decode()}}])
    return CallToolResult.model_validate(result)


async def main():
    server=Server('u0-fixture',on_list_tools=listing,on_call_tool=calling)
    async with stdio_server() as (read,write):
        await server.run(read,write,server.create_initialization_options())


if __name__=='__main__':
    asyncio.run(main())
