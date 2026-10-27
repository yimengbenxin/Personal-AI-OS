"""Image rehearsal: real loader, real phone MCP and real Mobilerun resources; fixture files only."""
import argparse
import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))


async def smoke(python, host_config):
    from capability.packages.load import load_packages
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    with tempfile.TemporaryDirectory(prefix='phone-launch-') as temporary:
        home = Path(temporary)
        secret_dir = home / 'fixture-secrets'
        secret_dir.mkdir()
        for name in ('deepseek.key', 'siliconflow.key', 'payment-executor.key'):
            path = secret_dir / name
            path.write_text('fixture-only-never-use')
            path.chmod(0o600)
        spec = importlib.util.spec_from_file_location('phone_smoke_cloud', host_config)
        cloud = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cloud)
        cloud.SECRETS = secret_dir
        os.environ.update(PAIOS_INTEGRATION_PORT='19661', PAIOS_DEPLOYMENT='image-smoke')
        binding = cloud.phone_runtime(home, ROOT / 'integrations/hermes/personal_aios', 'mac-android', time_zone='UTC')
        binding['command'] = python
        binding['env']['PAIOS_ERRAND_SPOOL'] = str(home / 'spool')
        selection = {'capability_packages': {'enabled': ['phone'], 'gateway': ['phone']}}
        servers, _, _ = load_packages(ROOT, selection, home, runtime_bindings={'phone': binding})
        phone = servers['phone']
        assert phone['cwd'] == str(ROOT / 'integrations/connectors/phone_executor')
        assert all('${' not in value for value in phone['env'].values())
        async with stdio_client(StdioServerParameters(command=phone['command'], args=phone['args'],
                               cwd=phone['cwd'], env=phone['env'])) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                assert len((await session.list_tools()).tools) == 8
        # Use the same resolved cwd/env for model resource initialization, without a driver or a task.
        previous = Path.cwd()
        with contextlib.redirect_stdout(sys.stderr):
            os.environ.update(phone['env'])
            sys.path.insert(0, phone['cwd'])
            import server as executor
            executor._load_model()
            os.chdir(phone['cwd'])
            try:
                config = executor._mobile_config()
                from mobilerun.config_manager.prompt_loader import PromptLoader
                from mobilerun.app_cards.providers.local_provider import LocalAppCardProvider
                prompt = await PromptLoader.load_prompt(config.agent.get_fast_agent_system_prompt_path(),
                    {'available_tools': set(), 'output_schema': None, 'variables': {}, 'platform': 'android'})
                assert prompt.strip()
                cards = LocalAppCardProvider(config.agent.app_cards.app_cards_dir)
                assert await cards.load_app_card('com.aliyun.tongyi', platform='android')
                file_envs = {'PAIOS_DEEPSEEK_KEY_FILE', 'PAIOS_SILICONFLOW_KEY_FILE', 'PAIOS_PAYMENT_KEY_FILE'}
                file_envs.update(profile.kwargs['api_key_file_env'] for profile in config.llm_profiles.values()
                                 if profile.kwargs.get('api_key_file_env'))
                for name in file_envs:
                    assert Path(os.environ[name]).read_text().strip()
                for target in (Path(config.logging.trajectory_path) / 'probe.json', Path(config.credentials.file_path)):
                    assert target.is_relative_to(home)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text('fixture-only')
                executor._bind(config)
                for profile in config.llm_profiles.values():
                    for name in ('http_client', 'async_http_client'):
                        client = profile.kwargs.get(name)
                        if client:
                            if name == 'http_client':
                                client.close()
                            else:
                                await client.aclose()
                assert 'agentbay_phone' not in sys.modules
            finally:
                os.chdir(previous)
        return {'real_phone_mcp': True, 'tools': 8, 'mobilerun_config': True, 'prompt': True,
                'app_cards': True, 'writable_trajectory_and_credentials': True,
                'key_file_env_names': sorted(file_envs), 'agentbay_calls': 0, 'model_calls': 0,
                'cwd': phone['cwd'], 'env_names': sorted(phone['env'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--host-config', type=Path, default=ROOT / 'deploy/cloud/hermes-init.py')
    args = parser.parse_args()
    print(json.dumps(asyncio.run(smoke(args.python, args.host_config))))
