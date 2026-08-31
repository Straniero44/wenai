# ComfyUI Workflow 说明

本目录包含两份工作流：生图（nsfw-v1.0.json，main/voice 分支均有）与语音（voice-qwen.json，仅 voice 分支）。

---

# 生图工作流（nsfw-v1.0.json）

适配模型：**Pony Diffusion V6 XL**（`ponyDiffusionV6XL_v6StartWithThisOne.safetensors`）

## 节点结构

| 节点 | 类型 | 作用 |
|---|---|---|
| 4 | CheckpointLoaderSimple | 加载 Pony V6 XL 主模型 |
| 24 | LoraLoader | 画风 LoRA（[Artist] Asanagi_Geekpower [PDXL]，强度 1.0） |
| 27 | LoraLoader | 镜头/表现力 LoRA（cinematic expression style pony v1.1，强度 0.6） |
| 80 | PrimitiveString | 品质前缀（`zPDXL3, Asanagi`） |
| **74** | StringConcatenate | **正面提示词拼接（string_b 为提示词输入口）** |
| 6 | CLIPTextEncode | 正向条件编码 |
| 7 | CLIPTextEncode | 负向条件编码（内置反 3D/写实/坏手等负面词） |
| 5 | EmptyLatentImage | 画布：1280×1024 |
| 92 | KSampler | 采样：dpmpp_2m_sde / karras，45步，CFG 6 |
| 87 / 89 / 8 | VAE 系列 | sdxl_vae 编解码 |
| 110 / 109 / 123 | 图像输入组 | 图生图入口（不连入时走文生图） |
| 15 | SaveImage | 输出 |

## 使用方法

1. 导入 JSON 到你的 ComfyUI，确保已下载：Pony V6 XL 主模型、两个 LoRA、sdxl_vae
2. 正面提示词写入节点 **74 的 string_b**（会自动拼接节点 80 的品质前缀）：
   - 固定开头：`score_9, score_8_up, score_7_up`
   - 接 Danbooru 风格标签（如 `1girl, black hair, ...`）
   - 结尾：`masterpiece, best quality`
3. 负面提示词已内置在节点 7，一般无需修改（含防写实/防畸变词）
4. Agent 对接：OpenClaw 用户在 comfy 插件配置中指定 `workflowPath` 指向本文件，`promptNodeId: 74`，`promptInputName: string_b`

## 注意

- LoRA 与主模型文件名需与本机 models 目录一致，缺哪个就在对应节点替换
- 两个 LoRA 可按喜好更换/删除（删除后需把 4→92 的 model/clip 连线直连）
- 分辨率在节点 5 调整；Pony XL 推荐 1024~1536 区间

---

# 语音工作流（voice-qwen.json，voice 分支）

适配模型：**Qwen3-TTS-12Hz-1.7B-CustomVoice**（本地部署的 Qwen3 TTS，含 instruct 情感指令控制）

## 节点结构

| 节点 | 类型 | 作用 |
|---|---|---|
| 1 | Qwen3TTSEngineNode | TTS 引擎：加载 Qwen3-TTS 模型，voice_preset=Serena，中文，**instruct 情感指令**（默认：连声浪叫、鼻音哭腔破音） |
| 2 | UnifiedTTSTextNode | **台词输入口（text）**：含分块（400字/块）、缓存、seed |
| 3 | SaveAudioAdvanced | 输出 mp3（128k，前缀 audio/voice） |
| 4 | PreviewAny | 预览 |

## 使用方法

1. ComfyUI 安装 Qwen3-TTS 自定义节点，下载模型 `Qwen3-TTS-12Hz-1.7B-CustomVoice`
2. 台词写入节点 **2 的 text**（对应 SKILL 语音流程中的"纯台词，<300字符"）
3. 情感风格在节点 **1 的 instruct** 调整（如：撒娇/哭腔/喘息等自然语言描述）
4. 语色在节点 1 的 voice_preset 切换（默认 Serena）
5. 输出 mp3 位于 ComfyUI output/audio/voice 目录，供 Agent 以语音消息发送

## 与生图工作流的区别

| | nsfw-v1.0.json | voice-qwen.json |
|---|---|---|
| 用途 | 场景配图 | 场景配音 |
| 模型 | Pony V6 XL（SDXL） | Qwen3-TTS-12Hz-1.7B |
| 输入 | 节点74 string_b（Danbooru标签） | 节点2 text（第一人称台词） |
| 输出 | PNG 图片 | mp3 音频 |

## 注意

- `runtime_mode` 默认 Shared Runtime（⚠️ 开头为正常显示，非错误）
- 分块参数 max_chars_per_chunk=400，台词较长时自动切分并 100ms 静音衔接
- enable_audio_cache=true：相同台词+参数命中缓存，重复生成零耗时
