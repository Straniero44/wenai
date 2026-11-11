# ComfyUI Workflow 说明

本目录包含三个生图工作流版本（nsfw-anime-v1.0.json = Pony 旧版 / nsfw-anime-v2.0.json = WAI 现行版 / nsfw-anime-v3.0.json = 动图版，WAI 静帧 + Wan 图生视频 GIF）。

---

# 生图工作流 v1.0（nsfw-anime-v1.0.json）

> **旧版（Pony 时代）**。现行版本为 v2.0（WAI），本章保留供回退参考。

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
3. 负面提示词已内置在节点 7，一般无需修改（含防写实/防 3D 渲染负面词）
4. Agent 对接：comfy 插件配置 `workflowPath` 指向本文件，`promptNodeId: 74`，`promptInputName: string_b`

## 注意

- LoRA 与主模型文件名需与本机 models 目录一致，缺哪个就在对应节点替换
- 两个 LoRA 可按喜好更换/删除（删除后需把 4→92 的 model/clip 连线直连）
- 分辨率在节点 5 调整；SDXL 推荐 1024~1536 区间

---

# 生图工作流 v2.0（nsfw-anime-v2.0.json）

> **当前使用版本（WAI）**。旧版 1.0（Pony）保留供回退参考。

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
| 19~23 | 图像输入组 | 图生图入口（不连入时走文生图） |

## 使用方法

1. 导入 JSON 到你的 ComfyUI，确保已下载：WAI-Nsfw-Illustrious-17 主模型、asanagi LoRA
2. 正面提示词写入节点 **17 的 string_b**（会自动拼接节点 18 的画风前缀）：
   - 固定开头：`rating_explicit, masterpiece, best quality, amazing quality, absurdres`
   - 接 Danbooru 风格标签（如 `1girl, black hair, ...`）
3. 负面提示词已内置在节点 3，一般无需修改（含防写实/防 3D 渲染负面词）
4. Agent 对接：comfy 插件配置 `workflowPath` 指向本文件，`promptNodeId: 17`，`promptInputName: string_b`

## 注意

- LoRA 与主模型文件名需与本机 models 目录一致，缺哪个就在对应节点替换
- asanagi LoRA 可按喜好更换/删除（删除后需把 1→5 的 model/clip 连线直连）
- 分辨率在节点 4 调整；SDXL 推荐 1024~1536 区间

---

# 生图工作流 v3.0（nsfw-anime-v3.0.json，动图版）

> **动图版**：在 v2.0（WAI）静帧基础上接 Wan 图生视频，输出 12fps 无限循环 GIF。**流程时间明显更长**（静帧 + 视频采样两段），追求速度或只要静态图仍用 v2.0。

适配模型：**WAI-Nsfw-Illustrious-17**（静帧，同 v2.0）+ **Wan 图生视频模型（fp8 unet HIGH/LOW 双档）**；可选 **Qwen3.5-VL**（AILab 节点，参考图自动反推提示词）

## 节点结构

| 节点 | 类型 | 作用 |
|---|---|---|
| 28 | LoadImage | 加载参考图（auto 模式用） |
| 238 | AILab_QwenVL_Advanced | Image to Prompt（Qwen3.5-VL 自动反推提示词） |
| 240 | ComfySwitchNode | auto / manual 提示词切换（True = auto） |
| **29 / 31** | PrimitiveStringMultiline | **手写提示词输入口（29 的 value = 正向完整提示词）** |
| 25:x 组 | CheckpointLoaderSimple / LoraLoader / KSampler / VAEDecode 等 | WAI 静帧生成（结构同 v2.0，首尾帧） |
| 236:xx 组 | WanFirstLastFrameToVideo / KSamplerAdvanced ×2 / CreateVideo 等 | 首尾帧图生视频（fp8 unet HIGH/LOW 双档） |
| 247 | ImageScaleBy | GIF 压缩：缩图 0.8x |
| 248 | ImageQuantize | GIF 压缩：64 色 bayer-8 |
| 243 | VHS_VideoCombine | GIF 输出（12fps 无限循环） |
| 242 | SaveVideo | 视频输出 |

## 使用方法

1. 导入 JSON 到 ComfyUI，除 v2.0 所需模型外另需：Wan 图生视频 fp8 unet（HIGH/LOW）、VHS（Video Helper Suite）插件；auto 模式另需 AILab QwenVL 插件与 Qwen3.5-VL 模型
2. 手写模式：节点 **240 置 False**，正向提示词写入节点 **29 的 value**（格式同 v2.0：`rating_explicit, masterpiece, best quality, amazing quality, absurdres` + Danbooru 标签）
3. auto 模式：节点 240 置 True，加载参考图到节点 28，由 Qwen3.5-VL 自动反推提示词
4. Agent 对接（手写模式）：comfy 插件配置 `workflowPath` 指向本文件，`promptNodeId: 29`，`promptInputName: value`
5. 动图体积已内置压缩（缩图 0.8x + 64色量化），若仍超限可继续调低 247 的 scale_by 或 248 的 colors

## 注意

- **流程时间明显长于 v2.0**（视频采样是耗时大头），建议按需切换 workflow
- 节点 id 带冒号（如 25:18）是子图（subgraph）节点，导入后属正常结构
- Wan 模型文件名需与本机 models 目录一致
