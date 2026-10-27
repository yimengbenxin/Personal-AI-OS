"""Real native agents/delegation/MCP with a loopback model and a loss-injecting HTTP proxy."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

request=json.loads(Path(sys.argv[1]).read_text())
ROOT=Path(request['root']);HOME=Path(request['home']);HOME.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(ROOT))
import yaml
def loopback_only(event,args):
    if event=='socket.connect' and isinstance(args[1],tuple) and args[1][0] not in {'127.0.0.1','::1'}:
        raise OSError('synthetic fixture permits loopback only')
    if event=='socket.getaddrinfo' and args[0] not in {'127.0.0.1','::1','localhost',None}:
        raise OSError('synthetic fixture permits loopback only')
sys.addaudithook(loopback_only)
os.environ.update(HERMES_HOME=str(HOME),HERMES_DISABLE_LAZY_INSTALLS='1',HERMES_SYNC_ENABLED='false',
    HERMES_ENABLE_PROJECT_PLUGINS='false',PYTHONDONTWRITEBYTECODE='1',NO_PROXY='127.0.0.1,localhost,::1')
records=[];model_requests=[];lock=threading.Lock();compressed=False
TOOL='mcp__u0_fixture__effect'


class Service(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def answer(self,value,status=200):
        data=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def proxy(self,body=None):
        if request['mode']=='disconnect':return self.answer({'error':'fixture_disconnect'},503)
        if self.path.endswith('/lifecycle'):
            payload=body['payload']
            if request['mode']=='loss' and body['hook'] in {'pre_llm_call','pre_api_request'}:
                return self.answer({'error':'fixture_observer_loss'},503)
            if request['mode']=='loss-turn' and body['hook']=='pre_llm_call':
                return self.answer({'error':'fixture_observer_loss'},503)
            if request['mode']=='loss-start' and body['hook']=='subagent_start':
                return self.answer({'error':'fixture_observer_loss'},503)
        data=None if body is None else json.dumps(body).encode()
        rpc=Request(request['base']+self.path,data=data,headers={'Authorization':self.headers['Authorization'],'Content-Type':'application/json'})
        try:
            with urlopen(rpc,timeout=10) as reply:status,payload=reply.status,reply.read()
        except HTTPError as error:status,payload=error.code,error.read()
        with lock:records.append({'operation':self.path.rsplit('/',1)[-1],'body':body,'status':status})
        if request['mode']=='recovery' and self.path.endswith('/decide') and status==200:
            Path(request['gate']).write_text(json.dumps(body))
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)))
        self.end_headers();self.wfile.write(payload)
    def do_GET(self):self.proxy()
    def do_POST(self):
        global compressed
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
        if self.path!='/v1/chat/completions':return self.proxy(body)
        messages=body['messages'];model_requests.append(messages)
        index=max(i for i,message in enumerate(messages) if message['role']=='user' and re.search(r'U0_(ROOT|CHILD_[12])_',str(message['content'])))
        text=str(messages[index]['content']);after=messages[index+1:]
        marker=re.search(r'U0_(?:ROOT|CHILD_[12])_([a-z0-9-]+)',text)
        label=marker[1] if marker else 'fixture'
        if any(message['role']=='tool' for message in after):message={'role':'assistant','content':'U0_DONE '+label}
        else:
            if 'U0_CHILD_2_' in text or 'U0_CHILD_1_' in text and request['depth']==1:
                name,args=TOOL,{'label':label}
            else:
                depth=2 if 'U0_CHILD_1_' in text else 1
                name,args='delegate_task',{'goal':f'U0_CHILD_{depth}_{label}: use the fixture tool once and report its receipt.','background':False}
                if depth==1 and request['depth']>1:args['role']='orchestrator'
            message={'role':'assistant','content':None,'tool_calls':[{'id':'fixture-'+str(len(model_requests)),
                'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]}
        if request['mode']=='compression' and not compressed:
            compressed=True
            from hermes_state import SessionDB
            database=SessionDB(HOME/'state.db')
            root=request['roots'][0]
            database.publish_compression_child(parent_session_id=root['session'],child_session_id=root['session']+'-compressed',
                source='api_server',messages=[{'role':'user','content':root['input']}],require_compression_lease=False)
            database.close()
        reply={'id':'fixture','object':'chat.completion','created':0,'model':'fixture-model',
            'choices':[{'index':0,'message':message,'finish_reason':'tool_calls' if message.get('tool_calls') else 'stop'}],
            'usage':{'prompt_tokens':8,'completion_tokens':4,'total_tokens':12}}
        if not body.get('stream'):return self.answer(reply)
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        delta={key:value for key,value in message.items() if key!='role' and value is not None}
        if 'tool_calls' in delta:
            delta['tool_calls']=[{'index':i,**call} for i,call in enumerate(delta['tool_calls'])]
        for content,finish in [(delta,None),({},reply['choices'][0]['finish_reason'])]:
            self.wfile.write(('data: '+json.dumps({'id':'fixture','object':'chat.completion.chunk','created':0,'model':'fixture-model',
                'choices':[{'index':0,'delta':content,'finish_reason':finish}],'usage':reply['usage']})+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()


server=ThreadingHTTPServer(('127.0.0.1',0),Service);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
base=f'http://127.0.0.1:{server.server_address[1]}'
key=HOME/'internal.key';key.write_text(request['token']);key.chmod(0o600)
settings={'internal_base_url':base,'internal_key_file':str(key),'capability_tools':[TOOL]}
config={'model':{'default':'fixture-model','provider':'custom:fixture','base_url':base+'/v1','context_length':64000,'supports_vision':True},
    'custom_providers':[{'name':'fixture','provider_key':'fixture','base_url':base+'/v1','model':'fixture-model','key_env':'U0_MODEL_KEY','api_mode':'chat_completions'}],
    'plugins':{'enabled':['yimi-gateway'],'entries':{'yimi-gateway':{'settings':settings}}},
    'agent':{'max_iterations':4,'image_input_mode':'native'},'memory':{'memory_enabled':False,'user_profile_enabled':False},
    'delegation':{'model':'fixture-model','provider':'custom:fixture','base_url':base+'/v1','context_length':64000,
        'max_spawn_depth':3,'max_iterations':4,'child_timeout_seconds':30,'inherit_mcp_toolsets':True,'fallback_providers':[]},
    'auxiliary':{'title_generation':{'enabled':False},'vision':{'enabled':False}},'cron':{'enabled':False},
    'personal_aios':{'capability_tools':[TOOL],'delegated_toolsets':['mcp-u0_fixture','delegation']},
    'tools':{'tool_search':{'enabled':'off'}},'mcp_servers':{'u0_fixture':{'command':sys.executable,
        'args':[str(ROOT/'tests/hermes/fixtures/u0-mcp.py')],'env':{'PYTHONPATH':str(ROOT),
            'HERMES_HOME':str(HOME),'U0_EFFECT_LOG':str(HOME/'effects.jsonl'),'U0_MEDIA':'1' if request['mode']=='media' else '0',
            'U0_MODE':request['mode'],'U0_READY':request['ready'],'U0_RELEASE':request['release']},'trust':'full'}}}
os.environ['U0_MODEL_KEY']='synthetic-fixture-key'
(HOME/'config.yaml').write_text(yaml.safe_dump(config));(HOME/'plugins').mkdir(exist_ok=True)
(HOME/'plugins/yimi_gateway').symlink_to(ROOT/'integrations/hermes/yimi_gateway',target_is_directory=True)
from hermes_cli.plugins import get_plugin_manager
get_plugin_manager().discover_and_load()
from tools.mcp_tool_discovery import register_mcp_servers
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
register_mcp_servers(config['mcp_servers'])
from run_agent import AIAgent
from hermes_state import SessionDB
database=SessionDB(HOME/'state.db')


def run(root):
    pending=set()
    def progress(event,*args,**fields):
        if event.startswith('subagent.'):
            if args:fields.setdefault('preview',str(args[0]))
            with lock:
                identity=fields.get('subagent_id')
                if identity and event in {'subagent.spawn_requested','subagent.start'}:pending.add(identity)
                if identity and event=='subagent.complete':pending.discard(identity)
                with Path(request['progress']).open('a') as stream:
                    stream.write(json.dumps({'event':event,'run_id':root['run'],'timestamp':time.time(),**fields})+'\n')
    agent=AIAgent(model='fixture-model',provider='custom:fixture',base_url=base+'/v1',api_key='synthetic-fixture-key',
        max_iterations=4,enabled_toolsets=['delegation','mcp-u0_fixture'],quiet_mode=True,
        skip_context_files=True,platform='api_server',session_id=root['session'],session_db=database,tool_progress_callback=progress)
    try:
        result=agent.run_conversation(root['input'],task_id=root['session'])
        deadline=time.monotonic()+45
        while pending and time.monotonic()<deadline:time.sleep(.02)
        assert not pending,'native child completion timeout: '+str(pending)
        return result
    finally:agent.close()


try:
    with ThreadPoolExecutor(max_workers=len(request['roots'])) as executor:results=list(executor.map(run,request['roots']))
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        starts=sum(row['operation']=='lifecycle' and row['body']['hook']=='subagent_start' and row['status']==200 for row in records)
        stops=sum(row['operation']=='lifecycle' and row['body']['hook']=='subagent_stop' and row['status']==200 for row in records)
        if stops>=starts:break
        time.sleep(.02)
    effects=[json.loads(line) for line in (HOME/'effects.jsonl').read_text().splitlines()] if (HOME/'effects.jsonl').exists() else []
    summaries=[row.get('final_response') for row in results]
    observed=[row for row in records if row['operation']=='observe']
    resource_paths=[path for messages in model_requests for message in messages if message['role']=='tool'
        for path in re.findall(r'MCP resource saved to ([^ ]+)',str(message.get('content')))]
    print(json.dumps({'fixture':'u0-native','mode':request['mode'],'effects':effects,'final':summaries,
        'hooks':[{'hook':row['body'].get('hook'),'payload':row['body'].get('payload'),'status':row['status']}
            for row in records if row['operation']=='lifecycle'],
        'tool_ids':[{key:row['body'][key] for key in ['task_id','turn_id','api_request_id','session_id']} for row in observed],
        'media_in_model':any('MEDIA:' in str(message.get('content')) for messages in model_requests for message in messages if message['role']=='tool'),
        'image_in_model':any(isinstance(message.get('content'),list) and any(block.get('type')=='image_url' for block in message['content'])
            for messages in model_requests for message in messages if message['role']!='system'),
        'resource_bytes_preserved':any(Path(path).is_file() and Path(path).read_bytes()==b'synthetic attachment' for path in resource_paths),
        'compressed':compressed},ensure_ascii=False))
finally:
    shutdown_mcp_servers();database.close();server.shutdown();thread.join()
