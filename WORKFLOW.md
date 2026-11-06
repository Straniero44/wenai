# ComfyUI Workflow 说明（nsfw-v1.0.json）

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

# 生图工作流 v2.0（nsfw-v2.0.json）

> **当前使用版本**。与 1.0 并存：1.0 = Pony V6 XL（旧版），2.0 = WAI NSFW Illustrious SDXL（现行）。

适配模型：**WAI-Nsfw-Illustrious-17**（`WAI-Nsfw-Illustrious-17.safetensors`）

## 节点结构

| 节点 | 类型 | 作用 |
|---|---|---|
| 1 | CheckpointLoaderSimple | 加载 WAI-Nsfw-Illustrious-17 主模型 |
| 13 | LoraLoader | 画风 LoRA（asanagi，强度 0.5） |
| 18 | PrimitiveString | 画风前缀（`asanagi style`） |
| **17** | StringConcatenate | **正面提示词拼接（string_b 为提示词输入口）** |
| 2 | CLIPTextEncode | 正向条件编码 |
| 3 | CLIPTextEncode | 负向条件编码（内置反 3D/写实负面词） |
| 4 | EmptyLatentImage | 画布：1280×1024 |
| 5 | KSampler | 采样：euler_ancestral / normal，28 步，CFG 5.5 |
| 6 | VAEDecode | 解码 |
| 7 | SaveImage | 输出（前缀 nsfw/nsfw） |
| 19~23 | 图像输入组 | 图生图入口（LoadImage→VAEEncode→ImageBatchFilter→ifElse，不连图时走文生图） |

## 使用方法

1. 导入 JSON 到你的 ComfyUI，确保已下载：WAI-Nsfw-Illustrious-17 主模型、asanagi LoRA
2. 正面提示词写入节点 **17 的 string_b**（会自动拼接节点 18 的画风前缀）：
   - 固定开头：`rating_explicit, masterpiece, best quality, amazing quality, absurdres`
   - 接 Danbooru 风格标签（如 `1girl, black hair, ...`）
3. 负面提示词已内置在节点 3（防写实/防 3D 渲染词），一般无需修改
4. Agent 对接：comfy 插件配置 `workflowPath` 指向本文件，`promptNodeId: 17`，`promptInputName: string_b`

## 注意

- 与 1.0 的差异：质量前缀由 score_9 系改为 masterpiece 系；采样器改为 euler_ancestral（28 步 / CFG 5.5）
- LoRA 与主模型文件名需与本机 models 目录一致，缺哪个就在对应节点替换
- 分辨率在节点 4 调整；SDXL 推荐 1024~1536 区间
