# Personal-AI-OS 0.1.5

让每个人都有自己的依米：部署在自己的服务器上，连接自己选择的模型、数据和设备。这一版里，依米可以换用部署者自备的本地模型；新增了可选的会议助手服务端能力和 Keynote 编辑协议；对外发送的许可细化到收件人和消息类别。从这一版起，版本号跟随项目自身的发布序列，0.0.2 之后直接是 0.1.5。

模型设置新增本地模型目录。语音识别、语音活动检测、声纹、唤醒词和向量模型可以通过签名请求切换，也可以退回上一个模型。语音类模型要重启服务后才加载；换声纹模型后要重新录入和校准；换唤醒词模型时，原有的唤醒词和通话中断词必须保留；向量模型要先建好新索引再切换；人脸模型不在这里切换。模型文件和运行环境由部署者自备，目录本身不下载、也不安装模型。

改模型配置或换密钥后，服务会保留切换仍需要的旧密钥，直到确认新设置已启用。估算费用时，能区分缓存写入是按普通输入计价还是单独计价；缺少计量或价格时，费用仍标为未知。如果主脑配有有序后备路由，而通话分类 `call.intent` 的后备链为空，可以用新增的命令把这条后备路由补给它。

新增可选的会议服务端能力包和 Keynote 编辑协议。它用于读取指定本地 Keynote 的当前页和文字，再结合会上的话、眼镜画面和投影片，定位到唯一对应的文字元素。实际读写还需要实现该协议的 Mac 执行端，本版所附的 Mac 源码尚未提供。修改只限替换文字和追加段落，每条修改都绑定原页面、原文和预览。第一次修改需要确认，确认后会对同一文件、同一台电脑和允许的操作类型建立最长两小时的会话许可。结果不明时，先查询原来那次操作，核对修改前后的文字回读。会议媒体只用于这场会议，不进入日常的人物与情绪记录。

对外发送的许可按解析出的收件人和消息类别（文本、文件、添加或移除反应等）来认。微信收件人必须在通讯录里唯一匹配；按名称匹配有歧义或查不到时，就不发送。升级迁移会把能无歧义识别的旧许可加入新的许可空间，旧记录照常保留；分不清文本与附件的旧通用许可，以及收件人不明确的许可，会留在未迁移清单里，需要重新确认。需要确认的操作中断后恢复，或者写操作结果不明时，先核查原来那次操作，不会自动重做。手机任务遇到来源无法核实的付款记录，会先核对原订单再继续。

手机聊天默认显示最新 150 行，每次往前展开 100 行；超长消息先显示开头，可以打开全文。随身模式下，眼镜的空闲画面会显示一条最多 48 字符、两行的短回复；眼镜与其他客户端使用同一张获授权的 AI 生成虚构默认头像；公开源码将随身回复界面的头像文件替换为中性的矢量占位图。Mac 离线时也能解除配对。服务端执行可选的历史隔离后，手机、手表、Mac 和眼镜收到可信的新历史代次，就会清掉旧的本地历史，所以四端要一起升级。

依米的说话偏好可以在语气、表达和习惯里选择，最多 1500 字符，可以恢复上一版。执行结果会合并重复的事实，每次最多展示 12 项。声纹阈值按采集通道逐步上调，重启或调低配置都不会让它自动降低；通话里没核实的声音，不会因为这通电话是已配对用户发起的，就算作已核实。部署时区从 `PAIOS_TIME_ZONE`、产品配置或宿主机时区解析，然后固定下来。感谢 Chirag Jangir（#15）和 Pralav Singh（#16）的贡献。

Personal AI OS 0.1.5 adds a local model catalog to model settings. Speech recognition, voice activity detection, voiceprint, wake-word and embedding models are switched through signed requests; speech models load after a service restart, a voiceprint change requires re-enrollment and calibration, and the deployer supplies model files and runtimes. An optional meeting package adds server orchestration and a Keynote editing protocol. It limits planned edits to replacing text and appending paragraphs, and asks for confirmation before the first edit, which then opens a session grant of up to two hours. Actual reads and writes require a Mac executor that implements this protocol; the included Mac source does not yet provide one. Send consent is now keyed to the resolved recipient and message category; the migration keeps legacy records and leaves ambiguous grants for re-confirmation. Interrupted confirmations and writes with unknown outcomes are checked against the original operation instead of being repeated automatically. The phone chat loads history lazily, the glasses show short replies in companion mode, and clients clear old local history after receiving a trusted new history epoch. A new command can give `call.intent` the brain's ordered fallbacks when its own fallback chain is empty, and the deployment time zone is resolved and fixed when the configuration is rendered. Version numbers now follow the project's release sequence, so 0.1.5 comes directly after 0.0.2. See the README and the release page for upgrade steps.

# Personal-AI-OS 0.0.2

让每个人都有自己的依米：部署在自己的服务器上，连接自己选择的模型、数据和设备。这一版把依米会做的事整理成统一的能力包。

米家、手机任务、消息、微信、桌面、Mac 和内置工具都以能力包接入，每个包可以单独启用和回退（单机外设还需启用对应开关），确认和执行回执各走同一份合同。能力包是本项目在 Hermes 之上的一层，不改动上游。查找技能和 MCP 服务、检查包的合同、登记和回退，都在同一个工坊里完成。

模型设置只有一个权威来源：单机部署第一次启动时从 `.env` 导入主脑、视觉和工坊的配置，之后沿用已保存的设置和凭据，改动在客户端的“模型与密钥”页面进行。启动命令需要在 Linux 部署主机上以 root 身份执行，工坊使用独立的 1 GiB ext4 容量卷。模型用量分开记录输入、输出、缓存读取和缓存写入，用量或费用无法确认时保留估算或未知标记。

新版本启动时把 Hermes 原生核心记忆里已有的条目导入个人记忆。通过正式发布流程回退后，旧版本读取的是当前核心记忆资料的投影；重新升级只导入回退期间新增的条目；代码回退仍不撤销数据库变更或外部操作。

手机、手表和 Mac 的连接、音频与界面更新以源码交付，第三方 SDK 和模型资源需另行取得。保留社区贡献的 Mac 桌面模拟器指南和原生端测试的环境说明。项目继续采用 Apache-2.0；独立运行的米家 MCP 服务保留 GPL-3.0-or-later 许可，见 NOTICE。

Personal AI OS 0.0.2 organizes Yimi's capabilities into capability packages with shared consent and receipt contracts, each enabled and rolled back on its own (single-host peripherals also need their corresponding switches enabled); they are this project's layer on top of Hermes, not an upstream change. Brain, vision and workshop settings have one authority, imported from `.env` on first start. Existing Hermes native core memories are imported at release startup, and release rollback projects the current core memory profile. Third-party SDKs and model resources are obtained separately. See README for deployment requirements and LICENSE / NOTICE for licensing.

# Personal-AI-OS 0.0.1

让每个人都有自己的依米：部署在自己的服务器上，连接自己选择的模型、数据和设备。未来，各自使用者的依米可以在授权范围内相互协商。

这个源码版本包含 Linux 容器服务端，以及手机、眼镜、手表和 Mac 客户端。服务端连接设备输入、实时通话、个人时间线、记忆、归档和工具执行。模型按角色配置；依米的声音来自 Qwen。

对外发送遵循同一收件人和同一任务类型的首次确认。支付授权绑定本次请求，默认使用手机确认卡；语音支付和小额自动支付需在手机单独启用，两项默认关闭，并保留各自的身份、金额与撤销条件。工具工坊提供隔离执行空间；发布工具支持版本回滚。回滚不撤销数据库变更或外部系统操作。

服务端以源码和 Compose 交付，在本机构建镜像；0.0.1 不发布 GHCR 镜像。iPhone、Mac、手表和眼镜均以源码与构建说明交付，0.0.1 不附带预编译客户端。部署与客户端资源要求见 README 和 docs/。第三方 SDK、模型和外部服务遵循各自许可与使用条件。项目采用 Apache License 2.0；文件与 NOTICE 标明的许可例外继续适用，包括独立运行的 GPL 米家 MCP 服务。

Personal AI OS is a self-hosted personal assistant across phone, glasses, watch, and Mac. Model roles are configuration; Qwen provides its voice. See README for deployment requirements and consent boundaries, and LICENSE / NOTICE for licensing.
