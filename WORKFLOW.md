# ComfyUI Workflow 说明

本目录包含一个三次元（real）写实生图工作流（nsfw-real-v1.0.json = MOSS-Image 文生图 + Krea2 身份编辑换脸）。

---

# 生图工作流 v1.0（nsfw-real-v1.0.json）

> **当前使用版本（real 写实管线）**。两段式：第一段 MOSS-Image 生成写实场景，第二段 Krea2 身份编辑把女主正脸（`assets/face-real.jpg`）换到画面人物上。

适配模型：**MOSS-Image SFT turbo**（`moss_image_sft_turbo_int8_convrot.safetensors`）+ **NSFW LoRA**（`MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI.safetensors`，强度 0.7）；换脸段 **Krea2 turbo**（`krea2TurboOfficialComfy_krea2TurboFp8.safetensors`）+ **identity edit LoRA**（`krea2_identity_edit_v2.safetensors`，强度 1.0）

## 节点结构

### 第一段：MOSS-Image 文生图

| 节点 | 类型 | 作用 |
|---|---|---|
| 18:1 | UNETLoader | 加载 MOSS-Image SFT turbo 主模型（int8） |
| 18:37 | LoraLoaderModelOnly | NSFW LoRA（强度 0.7） |
| 18:2 / 18:3 | CLIPLoader / VAELoader | 文本编码 qwen3.5_9b_w4a8_gptq（moss_image）/ flux2-vae |
| 18:14 | PrimitiveStringMultiline | LLM 改写系统提示（中文粗需求 → 英文图像提示词） |
| **18:17** | PrimitiveStringMultiline | **正面提示词直输口（value 为提示词输入口）** |
| 18:16 | ComfySwitchNode | False=直输 18:17 / True=经 18:11 TextGenerate LLM 改写 |
| 18:31 | StringConcatenate | 提示词 + 全局审美前缀（Douyin/小红书美女风格串） |
| 18:4 / 18:5 | CLIPTextEncode | 正/负条件编码 |
| 19 | ResolutionSelector | 分辨率（默认 1:1 · 1MP · 16 倍数） |
| 18:24 | ComfySwitchNode | False=LoRA 模型 / True=18:15 SkipLayerGuidance（SLG） |
| 18:7 | KSampler | 采样：euler / simple，12 步，CFG 1 |
| 18:8 | VAEDecode | 解码出图 |
| 9 | SaveImage | MOSS 直出（前缀 nsfw-real/nsfw-img-mt） |

### 第二段：Krea2 身份编辑（换脸）

| 节点 | 类型 | 作用 |
|---|---|---|
| **76** | LoadImage | **女主正脸参考图输入口（默认文件名 face-real.jpg，即本仓库 assets/face-real.jpg）** |
| 81 / 82 | PrimitiveStringMultiline | head_swap（脸+发型全换）/ face_swap（仅脸部）编辑指令 |
| 78 | ComfySwitchNode | False=head_swap / True=face_swap |
| 75:64 / 75:65 | UNETLoader / LoraLoaderModelOnly | Krea2 turbo（fp8）+ identity_edit_v2 LoRA |
| 75:66 / 75:67 | CLIPLoader / VAELoader | qwen3vl_4b_bf16（krea2）/ qwen_image_vae |
| 75:10 / 75:68 | VAEEncode | 编码 MOSS 成品图 / 女主正脸图 |
| 75:12 / 75:69 | GetImageSize / EmptySD3LatentImage | 取原图尺寸 / 目标画布 |
| 75:70 / 75:71 | Krea2EditGroundedEncode | 正/负条件（image=MOSS 图 · image_b=正脸图 · grounding 768） |
| 75:72 | Krea2EditModelPatch | 身份编辑补丁（ref_boost 2 / ref_boost_a 4） |
| 75:73 | KSampler | 采样：euler / simple，8 步，CFG 1 |
| 75:74 | VAEDecode | 解码换脸成品 |
| 75:83 | ComfySwitchNode | True=输出换脸成品（False=跳过换脸） |
| **77** | SaveImage | **最终成品输出（前缀 nsfw-real/nsfw-img-kt）** |

## 使用方法

1. 导入 JSON 到你的 ComfyUI，确保已下载：MOSS-Image SFT turbo 主模型、NSFW LoRA、Krea2 turbo、identity edit LoRA、qwen3.5_9b / qwen3vl_4b 文本编码器、flux2-vae / qwen_image_vae
2. 女主正脸参考图：把 `assets/face-real.jpg` 上传到 ComfyUI 输入目录（节点 76 默认文件名即 face-real.jpg），或改节点 76 指向你的文件
3. 提示词写入节点 **18:17 的 value**（英文自然语言写实描述）；把 18:16 置 True 可走 18:11 TextGenerate 自动改写（配合 18:14 系统提示可投喂中文粗需求）
4. 采样步数/CFG 在 18:7、75:73；换脸强度可用 75:72 的 ref_boost 微调
5. Agent 对接：comfy 插件配置 `workflowPath` 指向本文件，`promptNodeId: 18:17`，`promptInputName: value`，`inputImageNodeId: 76`，`outputNodeId: 77`

## 注意

- 主模型 / LoRA / 编码器文件名需与本机 models 目录一致，缺哪个就在对应节点替换
- NSFW LoRA 强度默认 0.7，尺度偏软可上调（18:37）；换脸保真不足上调 75:72 的 ref_boost
- 想跳过换脸直接取 MOSS 原图：75:83 置 False，成品走节点 9
- 全局审美前缀在节点 18:31 的 string_b，可按需修改
- 分辨率在节点 19 调整（默认 1:1 · 1MP · 16 倍数）
