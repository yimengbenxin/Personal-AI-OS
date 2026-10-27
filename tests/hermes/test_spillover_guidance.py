"""Host-only large output guidance reaches the native child skill context."""
from test_skill_authority import PRODUCT


def test_host_spillover_guidance_is_once_in_shared_tool_learning():
    from tools.delegate_tool_progress import _build_child_system_prompt
    main = (PRODUCT / 'skills/personal-aios-main/SKILL.md').read_text()
    sentence = 'Hermes 的 spillover 文件用 read_file / search_files 读取，不用 execute_code；execute_code 在远程工坊，不能打开 Hermes 的 spillover 路径。'
    assert main.count(sentence) == 1
    child = _build_child_system_prompt('查询大型工具结果', context=main)
    assert sentence in child
