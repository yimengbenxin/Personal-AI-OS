"""Prior lifecycle backups also contain the erased test history; select only lifecycle-owned filenames."""
from pathlib import Path
import re

from data_reset_policy import require

SELECTIVE_ROOTS = {'release_dumps', 'snapshot_spool'}


def selected(role, relative):
    pattern = (r'releases/[^/]+/\.release/postgres-before\.dump' if role == 'release_dumps' else
               r'snapshot-\d{8}T\d{6}Z\.(?:age(?:\.partial)?|json|sent)')
    return re.fullmatch(pattern, relative) is not None


def objects(role, root):
    paths = root.glob('releases/*/.release/postgres-before.dump') if role == 'release_dumps' else root.iterdir()
    for path in sorted(paths):
        if selected(role, path.relative_to(root).as_posix()):
            require(path.is_file() and not path.is_symlink() and path.resolve() == path,
                    'RESET_HISTORY_BACKUP_UNSAFE')
            yield path
