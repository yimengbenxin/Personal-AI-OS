"""Scoped cold history: metadata-only inventory and same-drive server-side MOVE, never GET/PUT."""
import base64
from pathlib import Path
import re
import os
import shutil
import time
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
import xml.etree.ElementTree as ET

from data_reset_policy import RESET_ID, require

OBJECT = r'(?:[a-f0-9]{64}\.l5pack|backups/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}|originals/\d{4}-\d{2}-\d{2}/[A-Za-z0-9_-]+\.jpg)'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('RESET_COLD_REDIRECT_REFUSED')


class Cold:
    def __init__(self, config, prefix=None):
        self.prefix = prefix or '.rq102-quarantine/'+time.strftime('%Y-%m-%d',time.gmtime())+'-'+RESET_ID
        require(re.fullmatch(r'\.rq102-quarantine/\d{4}-\d{2}-\d{2}-RQ-102-N15',self.prefix),'RESET_COLD_QUARANTINE_SCOPE')
        self.config = config
        self.local = Path(config['directory']).resolve(strict=True) if 'directory' in config else None
        self.opener = build_opener(NoRedirect)
        if not self.local:
            url = urlsplit(config['url'])
            require(url.scheme in ('http','https') and not url.username and not url.password and not url.query and not url.fragment,
                    'RESET_COLD_URL')
            self.url = config['url'].rstrip('/')
            credential = config['username'] + ':' + Path(config['password_file']).read_text().rstrip('\r\n')
            self.auth = 'Basic ' + base64.b64encode(credential.encode()).decode()

    def path(self, relative):
        name = relative.removeprefix(self.prefix+'/').removeprefix('displaced/')
        require(re.fullmatch(r'\.rq102-quarantine/\.storage-[a-f0-9]{32}',relative) or
                relative in ('','.rq102-quarantine',self.prefix,self.prefix+'/displaced') or name in ('backups','originals') or
                re.fullmatch(r'originals/\d{4}-\d{2}-\d{2}',name) or re.fullmatch(OBJECT,name), 'RESET_COLD_UNKNOWN_OBJECT')
        return relative

    def request(self, relative, method, data=None, headers=None):
        self.path(relative)
        return self.opener.open(Request(self.url+'/'+quote(relative,safe='/'), data=data, method=method,
            headers={'Authorization':self.auth, **(headers or {})}), timeout=300)

    def listing(self, relative=''):
        self.path(relative)
        if self.local:
            path = self.local/relative
            if not path.exists():
                return None
            require(not path.is_symlink() and path.stat().st_dev==self.local.stat().st_dev,'RESET_COLD_UNSAFE_FILE')
            values = [path] if path.is_file() else sorted(path.iterdir())
            result = []
            for p in values:
                name = p.relative_to(self.local).as_posix()
                if not relative and name == '.rq102-quarantine':
                    continue
                self.path(name)
                require(not p.is_symlink() and p.stat().st_dev == self.local.stat().st_dev, 'RESET_COLD_UNSAFE_FILE')
                if p.is_dir():
                    result.extend(self.listing(name))
                else:
                    result.append({'path':name,'bytes':p.stat().st_size,'action':'clear'})
            return result
        try:
            with self.request(relative,'PROPFIND',b'<propfind xmlns="DAV:"><allprop/></propfind>',{'Depth':'1'}) as response:
                body = response.read(8 << 20)
                require(len(body) < 8 << 20,'RESET_COLD_LIST_TOO_LARGE')
        except HTTPError as error:
            if error.code == 404:
                return None
            raise ValueError('RESET_COLD_LIST_FAILED') from None
        result, base, seen = [], urlsplit(self.url).path.rstrip('/')+'/', False
        for item in ET.fromstring(body).findall('{DAV:}response'):
            href = unquote(urlsplit(item.findtext('{DAV:}href','')).path)
            require(href.rstrip('/') == base.rstrip('/') or href.startswith(base),'RESET_COLD_SCOPE_ESCAPE')
            name = href[len(base):].rstrip('/')
            prop = item.find('{DAV:}propstat/{DAV:}prop')
            require(prop is not None,'RESET_COLD_LIST_FAILED')
            collection = prop.find('{DAV:}resourcetype/{DAV:}collection') is not None
            if name == relative:
                seen = True
            if not name or name == relative and collection:
                continue
            if not relative and name == '.rq102-quarantine':
                continue
            require(name == relative or (name.rsplit('/',1)[0] == relative if '/' in name else not relative),
                    'RESET_COLD_DEPTH_MISMATCH')
            self.path(name)
            if collection:
                result.extend(self.listing(name) or [])
            else:
                size = int(prop.findtext('{DAV:}getcontentlength','-1'))
                require(size >= 0,'RESET_COLD_SIZE')
                result.append({'path':name,'bytes':size,'action':'clear'})
        require(seen,'RESET_COLD_LIST_FAILED')
        return result

    def inventory(self, strict=True):
        rows = sorted(self.listing() or [],key=lambda r:r['path'])
        require(len({r['path'] for r in rows}) == len(rows),'RESET_COLD_DUPLICATE_OBJECT')
        return rows

    def entries(self, before):
        groups = {}
        for row in before:
            root = row['path'].split('/')[0]
            groups.setdefault(root,[]).append(row)
        return [{'original':root,'quarantine':self.prefix+'/'+root,'files':len(rows),'bytes':sum(r['bytes'] for r in rows),
                 'members':rows,'state':'pending'} for root,rows in sorted(groups.items())]

    def mkdir(self, relative):
        self.path(relative)
        if self.local:
            (self.local/relative).mkdir(parents=True,exist_ok=True,mode=0o700)
            return
        parent = ''
        for part in relative.split('/'):
            parent = parent+'/'+part if parent else part
            try:
                with self.request(parent,'MKCOL'):
                    pass
            except HTTPError as error:
                require(error.code == 405 and self.listing(parent) is not None,'RESET_COLD_MKCOL_FAILED')

    def move(self, source, target):
        self.path(source); self.path(target)
        self.mkdir(target.rsplit('/',1)[0]) if '/' in target else None
        if self.local:
            original, destination = self.local/source, self.local/target
            require(original.stat().st_dev == destination.parent.stat().st_dev,'RESET_CROSS_FILESYSTEM')
            require(not destination.exists(),'RESET_COLD_DESTINATION_EXISTS')
            os.rename(original,destination)
        else:
            try:
                with self.request(source,'MOVE',headers={'Destination':self.url+'/'+quote(target,safe='/'),'Overwrite':'F'}) as response:
                    require(response.status in (201,204),'RESET_COLD_SERVER_MOVE_UNSUPPORTED')
            except HTTPError:
                raise ValueError('RESET_COLD_SERVER_MOVE_UNSUPPORTED') from None

    def check(self, entry, quarantined=True):
        root = entry['quarantine'] if quarantined else entry['original']
        rows = self.listing(root)
        expected = sorted((r['path'][len(entry['original']):],r['bytes']) for r in entry['members'])
        actual = sorted((r['path'][len(root):],r['bytes']) for r in rows or [])
        require(rows is not None and actual == expected,'RESET_COLD_MANIFEST_MISMATCH')

    def bind(self, identity):
        require(self.listing(self.prefix) is None,'RESET_COLD_QUARANTINE_EXISTS')
        self.mkdir('.rq102-quarantine/.storage-'+identity)
        self.check_identity(identity)

    def check_identity(self, identity):
        require(self.listing('.rq102-quarantine/.storage-'+identity)==[], 'RESET_COLD_MOUNT_CHANGED')

    def expire(self, identity):
        self.check_identity(identity)
        if self.listing(self.prefix) is None:
            return
        if self.local:
            shutil.rmtree(self.local/self.prefix)
        else:
            with self.request(self.prefix,'DELETE'):
                pass
        require(self.listing(self.prefix) is None,'RESET_COLD_DELETE_NOT_CONFIRMED')
