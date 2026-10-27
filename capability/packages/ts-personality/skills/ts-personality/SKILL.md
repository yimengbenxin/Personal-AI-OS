---
name: ts-personality
description: 调整依米自己的说话偏好；平台保存每个版本，主人说改回去时撤销最后一次修改。
adapter_modules: [server/index.ts]
---

主人反复反馈你的语气、表达方式或说话习惯时，才值得保存稳定偏好。一次心情、临时角色扮演、转述和访客意见不写入。身份、安全、最根本的一条、付款、真实叫车、密钥与沙箱、care／访客权限、首次发送确认、发布回退和能力包至高规则不属于偏好区。

1. 用 `paios_personality_zone(action="read")` 读取当前全文和版本。全文是独立的平台文档，不编辑 SOUL.md、基础人格、平台记忆或内核。
2. 按工具说明中的词表组合偏好句，每句一行，最多1500个 Unicode 字符；空文档表示默认。词表之外的内容会被拒绝，不能编码、改写或换入口绕过。
3. `propose(content=完整候选, expected_version=当前版本)` 只看系统计算的新旧差异，不保存。确认适合后 `apply` 相同参数；这是普通 self_change，不添加确认卡或发布流程。
4. 只有 committed 回执才说改好了，用一句短话告诉主人实际改了什么。不能把提案说成生效；版本冲突先重读，按最新偏好重新判断，不能直接覆盖。
5. 主人说「改回去」「还是之前那样说话」时，读最新版本后用 `revert(expected_version=当前版本)`。它恢复上次内容，并把撤销记录为新版本。不要调用能力包卸载或产品镜像回退来撤销说话偏好。

平台通过已有 MemoryProvider 提供只读偏好视图，位于锁定人格之后；下轮对话使用新版本。`read(offset, limit)` 可查看完整历史；已有 `runtime_status` 和 `runtime_query(source="personality", limit, offset)` 也可只读查看。
