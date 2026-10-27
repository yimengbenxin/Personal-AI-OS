"""Endpoint-contract probe only; synthetic files, no services or network."""
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
OLD = "8edc4bd4"
GATEWAY = "01-product-half-finished/backend/phase0/gateway"
SERVICES = "01-product-half-finished/backend/services"
BJ = "https://bj.example.invalid:9443"
US = "https://ai.example.invalid"

PROBE = r"""
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {loadHostConfiguration} from './01-product-half-finished/backend/services/personal-aios-integration/src/host-configuration.ts';
import {createConfiguredProductResources} from './01-product-half-finished/backend/phase0/gateway/src/rayneo-persistent-production-entrypoint.ts';
import {createPersistentRealtimePublicControlPorts} from './01-product-half-finished/backend/phase0/gateway/src/realtime-public-control-persistent-public-ports.ts';
import {makeMacProductResourceFixture} from './01-product-half-finished/backend/phase0/gateway/tests/mac-product-resource-fixture.ts';
const fixture=makeMacProductResourceFixture(process.env.PAIOS_SECRET_ROOT);
try {
  // The historical fixture supplies only synthetic identity/credential bytes.
  const loaded=await loadHostConfiguration(process.argv[2]);
  const c=loaded.product_resources, f=fixture.config;
  for(const key of ['postgres','owner_policy_file','livekit_key_file','livekit_secret_file','proxy_file','e2ee_file']) c[key]=f[key];
  writeFileSync(c.vidu_cleanup_key_file,'synthetic-vidu-key',{mode:0o600});
  const resources=createConfiguredProductResources(c);
  assert.equal(resources.configuration.public_api_url,process.env.PAIOS_PUBLIC_API_URL);
  const ports=createPersistentRealtimePublicControlPorts({publicApiUrl:c.public_api_url,
    legacyPublicApiUrls:c.legacy_public_api_urls,livekitUrl:c.livekit_url,livekitApiUrl:c.livekit_api_url,
    ownerProtection:resources.ownerProtection,secretFileReader:resources.secretFileReader,secretPaths:resources.secretPaths,
    bearerAuthority:{isReady:()=>true,resolve:async()=>undefined}});
  const authorize=host=>ports.edge.authorize({method:'POST',url:'/v1/realtime/bootstrap',remoteAddress:'127.0.0.1',controlHost:'127.0.0.1',
    rawHeaders:['host',host,'x-forwarded-host',host,'x-forwarded-proto','https',
      'x-paios-trusted-edge','tencent-nginx-loopback-v1','x-forwarded-for','198.51.100.7',
      'x-paios-trusted-source-family','ipv4','x-paios-proxy-attestation',readFileSync(c.proxy_file,'utf8').trim()]});
  await authorize(new URL(c.public_api_url).host);
  if(c.legacy_public_api_urls) await authorize(new URL(c.legacy_public_api_urls).host);
  else await assert.rejects(authorize('ai.example.invalid'),/PUBLIC_EDGE_HEADERS_INVALID/);
  assert.equal(ports.livekitUrl,c.livekit_url);
  assert.equal(ports.livekitApiUrl,'http://127.0.0.1:7880');
  await ports.close();
  console.log(JSON.stringify({rel26_config_accepted:true,canonical:c.public_api_url,aliases:c.legacy_public_api_urls,
    livekit:c.livekit_url,livekit_api:c.livekit_api_url,canonical_edge_accepted:true,
    legacy_edge:c.legacy_public_api_urls?'accepted':'rejected'}));
} finally {fixture.cleanup();}
"""


class RollbackEndpointTests(unittest.TestCase):
    def test_rel26_own_loader_and_edge_accept_n_rendered_endpoints(self):
        output = os.environ.get("PAIOS_ROLLBACK_PROBE_OUT")
        with tempfile.TemporaryDirectory(prefix="rollback-", dir=output) as temporary:
            # The real path: macOS hands out /var/folders, which node resolves to /private/var/folders.
            scratch = Path(temporary).resolve()
            archive = subprocess.run(["git", "-C", str(ROOT), "archive", OLD, GATEWAY, SERVICES, "integrations/contracts", "01-product-half-finished/backend/contracts", "integrations/hermes/personal_aios", "01-product-half-finished/backend/phase0/contracts", "deploy/cloud", "deploy/tencent"],
                                     check=True, capture_output=True).stdout
            archive_path = scratch / "source.tar"
            archive_path.write_bytes(archive)
            with tarfile.open(archive_path) as source:
                source.extractall(scratch)
            for section in ('phase0', 'services'):
                for package in (scratch / '01-product-half-finished/backend' / section).iterdir():
                    dependencies = ROOT / package.relative_to(scratch) / 'node_modules'
                    if package.is_dir() and dependencies.is_dir():
                        (package / 'node_modules').symlink_to(dependencies, target_is_directory=True)
            # Resolve missing package imports through the current shipped dependencies, retaining historical source.
            resolver = """
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
const archived=ARCHIVED, current=CURRENT;
let resolvingDependencies=false;
registerHooks({resolve(specifier,context,nextResolve){
  try{return nextResolve(specifier,context);}catch(error){
    if(!['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(error.code))throw error;
    if(!resolvingDependencies&&!specifier.startsWith('.')&&!specifier.startsWith('/')&&!specifier.includes(':')){
      resolvingDependencies=true;
      try{for(const owner of ['qwen-embedded','personal-aios-integration','platform-data']){
        try{return nextResolve(specifier,{...context,parentURL:current+'01-product-half-finished/backend/services/'+owner+'/package.json'});}
        catch(missing){if(!['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(missing.code))throw missing;}
      }}finally{resolvingDependencies=false;}
    }
    if(!context.parentURL?.startsWith(archived))throw error;
    const parentURL=current+context.parentURL.slice(archived.length);
    if(specifier.startsWith('.')||specifier.startsWith('/')){
      const target=new URL(specifier,context.parentURL).href;
      if(target.startsWith(archived)&&target.includes('/node_modules/'))return nextResolve(fileURLToPath(current+target.slice(archived.length)),{...context,parentURL});
      throw error;
    }
    if(specifier.includes(':'))throw error;
    return nextResolve(specifier,{...context,parentURL});
  }
}});
""".replace('ARCHIVED', json.dumps(scratch.as_uri()+'/')).replace('CURRENT', json.dumps(ROOT.as_uri()+'/'))
            hook = scratch / 'resolve-deps.mjs'
            hook.write_text(resolver)
            options = shlex.split(os.environ.get('NODE_OPTIONS', ''))
            options = [option for option in options if not option.startswith('--import=') or
                       Path(option.removeprefix('--import=')).is_file()]
            options.append('--import='+str(hook))
            (scratch / "probe.ts").write_text(PROBE)
            env = dict(os.environ, NODE_OPTIONS=shlex.join(options), PAIOS_PUBLIC_HOST="bj.example.invalid",
                       PAIOS_PUBLIC_API_URL=BJ, PAIOS_LIVEKIT_URL="wss://bj.example.invalid:9443",
                       PAIOS_LIVEKIT_API_URL="http://127.0.0.1:7880", PAIOS_STAGING_PUBLIC_HOST="staging.example.invalid",
                       PAIOS_SECRET_ROOT=str(scratch / "synthetic"), PAIOS_DATA_ROOT=str(scratch / "data"),
                       PAIOS_CONFIG_ROOT=str(scratch / "deploy/cloud"), PAIOS_MODEL_ROOT=str(scratch / "models"),
                       PAIOS_GATEWAY_PORT="8787", PAIOS_INTEGRATION_PORT="18661", PAIOS_HERMES_PORT="18662",
                       PAIOS_POSTGRES_PORT="5432", PAIOS_DASHSCOPE_ENDPOINT="wss://provider.example.invalid/realtime",
                       PAIOS_AVATAR_URL="")
            results = []
            for label, alias in (("state_a_rel26_renderer", US), ("state_b_n_expand", US), ("state_b_n_contract", "")):
                if label == "state_b_n_expand":
                    for relative in ("deploy/cloud/prepare-build.py", "deploy/cloud/staging_config.py", "deploy/cloud/cloud.json",
                                     "deploy/cloud/front.conf.in", "deploy/cloud/paios_roaming_guard.js.in",
                                     "deploy/cloud/paios-staging-snapshot.timer"):
                        target = scratch / relative
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(ROOT / relative, target)
                env["PAIOS_LEGACY_PUBLIC_API_URLS"] = alias
                subprocess.run([sys.executable, str(scratch / "deploy/cloud/prepare-build.py"), "--config-only"],
                               env=env, check=True, capture_output=True)
                result = subprocess.run(["node", str(scratch / "probe.ts"),
                                         str(scratch / "deploy/cloud/.build/production.json")],
                                        cwd=scratch, env=env, text=True, capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                results.append(dict(state=label, **json.loads(result.stdout.splitlines()[-1])))
            if output:
                (Path(output) / "rel26-endpoint-results.json").write_text(json.dumps(results, indent=2)+"\n")


if __name__ == "__main__":
    unittest.main()
