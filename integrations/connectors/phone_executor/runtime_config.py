"""Keep image-owned Mobilerun assets separate from writable executor state."""
from pathlib import Path


def load_config(loader, path, state):
    config = loader.load(str(path))
    assets = Path(__file__).parent
    state = Path(state)
    for agent in (config.agent.fast_agent, config.agent.manager, config.agent.executor):
        for field in ('system_prompt', 'user_prompt'):
            value = getattr(agent, field, None)
            if value and not Path(value).is_absolute() and (assets / value).exists():
                setattr(agent, field, str(assets / value))
    cards = config.agent.app_cards
    if not Path(cards.app_cards_dir).is_absolute():
        cards.app_cards_dir = str(assets / cards.app_cards_dir)
    for owner, field in [(config.logging, 'trajectory_path'), (config.credentials, 'file_path')]:
        value = Path(getattr(owner, field))
        if not value.is_absolute():
            setattr(owner, field, str(state / value))
    return config
