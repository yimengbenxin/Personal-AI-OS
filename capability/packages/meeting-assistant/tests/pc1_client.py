"""Fixture-only client of the real stdio package and its loopback bridge."""
import asyncio
import json
import os
import sys
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main():
    request = json.load(sys.stdin)
    params = StdioServerParameters(command=sys.executable, args=['-m', 'capability.hosts.python',
        'meeting_assistant=capability.packages.meeting-assistant.server.server'], env=dict(os.environ))
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            reply = await session.call_tool('meeting_assistant__'+request['tool'], request['args'])
            print(json.dumps(reply.model_dump(by_alias=True), ensure_ascii=False))


asyncio.run(main())
