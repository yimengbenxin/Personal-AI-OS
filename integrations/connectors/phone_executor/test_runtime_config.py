"""Real Mobilerun resources resolve from the executor while mutable state stays outside the image."""
import os
from pathlib import Path
import tempfile
import unittest

from mobilerun.config_manager import ConfigLoader


class RuntimeConfig(unittest.TestCase):
    def test_assets_and_writes_resolve_from_an_unrelated_read_only_working_directory(self):
        from runtime_config import load_config
        executor = Path(__file__).parent
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            previous = Path.cwd()
            try:
                os.chdir(executor.parents[2] / 'capability/packages/phone')
                config = load_config(ConfigLoader, executor / 'mobilerun-config.example.yaml', state)
            finally:
                os.chdir(previous)
            self.assertTrue(Path(config.agent.fast_agent.system_prompt).is_file())
            self.assertTrue(Path(config.agent.app_cards.app_cards_dir).is_dir())
            for path in [Path(config.logging.trajectory_path) / 'probe', Path(config.credentials.file_path)]:
                self.assertTrue(path.is_relative_to(state))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture-only')
