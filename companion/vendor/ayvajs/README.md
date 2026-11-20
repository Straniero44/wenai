# ayvajs（内置副本）

`companion` 只用到 `Ayva` 与 `TempestStroke`，但运行时必须能拿到它们。为了让 `companion/`
不依赖仓库外的 `ayvajs/` 目录，这里放一份源码副本。

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/ayvasoftware/ayvajs |
| 版本 | 0.19.0 |
| 提交 | `f6827035b233b80abe45345d76531e9ade755f34` |
| 许可证 | MIT，见 `LICENSE` |
| 来源 | `npm pack ayvajs@0.19.0` 的 tarball；`src/`、`index.js`、`LICENSE` 逐字节一致 |

`package.json` 是本仓库补的：只声明 `type: module`、`main` 和版本，让这个目录单独看也是
一个合法的 ESM 包，不参与 `npm install`。

## 为什么是整个 `src/`

`Ayva` 与 `TempestStroke` 会间接引入 `util/`、`behaviors/` 和 `devices/`。只挑两个文件出来
会让 import 图断掉，所以保留上游的完整 `src/`，只去掉测试和构建配置。没有删除或改写任何
逻辑，`companion` 也不修改这些文件。

`src/devices/` 里的浏览器设备类（Web Serial、Web Bluetooth、WebSocket）不会被 `companion`
实例化；它们只在构造时读 `globalThis.navigator`，在 Node 下 import 是安全的。

## 更新

```bash
cd /tmp && rm -rf ayvajs-update && mkdir ayvajs-update && cd ayvajs-update
npm pack ayvajs@<版本>
tar -xzf ayvajs-<版本>.tgz
cp -r package/src package/index.js package/LICENSE /path/to/companion/vendor/ayvajs/
```

再把 `package.json` 的 `version` 和本文件的「版本 / 提交」改成新值，然后跑 `npm test`。
`test/dependency.test.js` 会校验这份副本可以被单独加载，且 `TempestStroke.library` 仍是
`parameters.js` 里那 42 个名字。
