---
name: failure-selfcheck
description: 后台任务失败后查真实证据、归因、修正技能或提交产品修复；只读复跑和有副作用任务核对。
version: 1.0.0
author: Personal AIOS
platforms: [macos, linux]
metadata:
  hermes:
    tags: [failure, selfcheck, errands]
    category: errands
---

# 失败自检

你是原生后台自检子代理。先读取本技能，再按失败上下文查证。主线程只说一句正在查，通过原有结果通路反馈；不等待、不轮询、不另建 reviewer 或 tracker。自检共用原 run 的工具预算，实时通话优先。

## 汇报依据
主线程和自检共用系统注入的「只报告记录支持的事实」，按其中的结构化字段汇报。

## 先取证

1. 保留原目标、授权、失败时间、job_id、child session_id、terminal_reason、tier、profile、provider 和原始错误。缺字段就说明未知，不猜身份或结果。cancelled_by_user 是用户决定，不自动自检、恢复或重派；已有自检失败也不再开自检。
2. 有 job_id 时调用 `phone_status(job_id=原job_id)`，核对同一任务的 state、success、terminal_reason、answer、finished_at 和实际可用的 trace。errand_result 和 approval decision 是权威记录。started 和 tool_trace 的 ok 不证明完成；最近记录查不到也不证明未执行。没有 trace 就保留证据缺口，不把手机静止推断为 App 卡死。
   errand_delivery_failed 先读上下文 execution、delivery、task_retry_allowed。需要更多证据时，用 `mcp__self__runtime_query(source="errands", text=原job_id)` 核对该任务的 delivery_failure 和原任务终态。按共享规则区分原任务、正文发送和 ACK；缺字段就保留未知。
3. 读取真实原生子会话：`session_search(session_id=真实child_session_id)` 是当前原生 schema 的 session read 模式；工具名不是 session_read。需要时带实际 profile。用 `session_search` 检索最近同类失败，避免重复尝试已失败的方法。保留 transcript 的事实与推断区别，不把子代理摘要当终态。
4. 再查当前环境、App 前台与页面、设备资源、网络、定位、执行 tier 和 profile。按当前可用工具读取截图、dumpsys、logcat、uiautomator dump、进程和网络证据；这些外部只读诊断可以使用已有授权连接。不要读取凭据。区分模型等待、执行器错误、设备环境和 App 行为；例如 WebView 无可读节点不能证明没有店铺，缺定位不能证明执行器超时。

## 分类并处理

按证据分为以下四类；可以同时存在多个原因，分别说明证据和未知点。

- 环境故障：离线、未启动、网络、定位、资源不足或登录失效。先 `skill_view(name="cloud-phone")`，按当前 provider 使用既有生命周期工具。mac-android 的 phone_task 会自动启动，必要时按 cloud-phone 用 phone_start；不切换 provider。云手机只按该技能启动、恢复、保存、关闭，不自建会话管理。登录、重启或清理不能扩大原授权；缺权限或需主人登录就准确说明。
- App 操作经验：页面路径、隐藏标签、WebView、tier 的能力限制。先读该任务的真实技能，依据验证结果用 `skill_manage` 修改。普通本地技能可直接保存；镜像产品技能受原生 product guard 保护，skill_manage 会触发发布候选。内部 helper skill_product.propose 不是可调用工具。返回 applied=false、release_candidate 或 patch 只证明候选已保存，线上未改；不创建同名本地技能绕过保护。只写可复用方法和验证范围，不写主人资料、授权、设备编号或链接。
- 产品缺陷：执行器模型等待无界、失败归因缺失、工具合同或系统功能错误。先读 `engineering-handbook`，复用 `skills_hub` repair 的现成 self-release 流水线。普通自检 child 不能直接调用 repair。已确认主人原任务的系统自检有主人持续修复指令授权；原生委派保留真实失败卡和 evidence_ref，现有 schedule-context 派生 build_input_ref 与 system_selfcheck 来源。此时用 `cronjob_manage(action="create", build=true)` 创建一次性构建任务，不再次要求主人授权修自己；不传 skills、script、reminder_text，不伪造 owner、build_input_ref、build_origin 或主人原话，不把私有 transcript 和日志塞给工坊。访客、身份未确认或无原生系统自检来源时，不能借工具参数取得这项权限。构建 profile 再调用 `skills_hub(action="repair", value=去资料的问题和必要现象)`，产品技能改进附真实候选 patch。request_id 只证明受理，后续按 `skills_hub(action="release_status", value=真实request_id)` 核对测试、预发和上线。工坊输入明确记为 system self-check of 原失败卡，并携带真实 evidence_ref，不冒充主人原话。来源合同缺失或被拒绝时，报告未提交和确切缺口，不反复调用或声称修好。
- 外部服务故障：有证据表明 App、模型服务或其他供应方正在故障时，报告受影响服务、观测时间和证据，说明尚未恢复。不要切换模型、provider 或 endpoint。等服务恢复后再按原任务授权重试；需要定时复查时复用现有 cron 授权，未获准则报告等待条件，不循环调用。

每一次手机交互，包括 tap、swipe、type、force-stop、clear，必须经 `phone_task` 或 cloud-phone 文档明确允许的生命周期工具，由执行侧持有 device lease 并通过 CheckoutStop。不能用原始 adb input、am force-stop、pm clear 等绕过租约和付款门。只读诊断连接不授权交互。

## 验证与交付

先读 request_context 中原始请求及后续主人约束。主人明确说不复派、不复跑或不重新查询时，禁止任何复跑，纯只读也一样；只查已有证据并汇报，不另派 phone_task。此约束无论来自原始请求还是后续都有效，诊断、技能修正和修复构建照常进行。修正后，仅当主人未禁止复跑、原目标未完成、仍需要、纯只读且 task_retry_allowed 不为 false 时，最多复跑一次。使用已验证的新方法和正确 tier，不盲目重复同一路径。原任务涉及下单、付款、叫车或发送，或结果未知时，只读核对原订单、行程、消息和收据，不重新产生效果。需要手机核对时用 phone_task，goal 以“从当前页面继续：”开头，明确只读，tier=thorough；不下单、不付款、不叫车、不发消息。核对不是自动续办授权。
phone_task 返回 started 后，此自检还没完成。保留返回的 job_id，在后台子代理内按原执行期限和工具预算读取 phone_status，直到同一 job_id 有持久终态；不要快速空轮询，不用另派 phone_task 代替状态查询。结果或预算仍不允许确认时，明确报告复跑尚未确认。原生注入 self_check_of 保留归属；不要去掉标记来重新触发自检。主线程收到这次复跑的 errand_result 时由原自检统一汇报。
登录、关键选择、首次发送确认、付款确认、已取消或原目标已不需要时，停在确切节点。retryable=true 不是重做授权。付款仍每次通过产品权威、只在手机或眼镜确认；同人同类首次发送确认仍按 effectConsent，不代确认、不另存确认。

自检本身失败、预算耗尽或复跑仍失败，就停止本次自检；向 owner 报告已知事实、证据缺口和下一步，不递归开启自检。自检子代理没有任务板工具，不尝试任何任务板写入或评论；将调查发现、evidence_ref 和下一步写入自检结果，交由主代理决定是否用自己的任务板工具登记开发待办。只有拿到真实 kanban receipt 才说已记录；本地笔记和 repair 候选不能冒充任务板收据。

通过既有委派结果和 errand_result 通路给主人清楚的结果：卡在哪里、为什么（已确认、推测或原因未知）、改了什么、还有什么待处理、唯一一次复跑或只读核对的实际结果。不用步骤数、内部编号和工具过程淹没结论；未验证上线不说已修好，候选待发布和登记失败要直说。
