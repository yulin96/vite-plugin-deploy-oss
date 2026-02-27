# vite-plugin-deploy-oss

将 dist 目录上传到 OSS

## 介绍

`vite-plugin-deploy-oss` 是一个 Vite 插件，它可以将你的 dist 目录上传到 OSS 上。

## 安装

```bash
pnpm add vite-plugin-deploy-oss -D
```

## 使用

```ts
// vite.config.ts
import vitePluginDeployOss from 'vite-plugin-deploy-oss'

// ...existing code...
export default {
  // ...existing code...
  plugins: [
    // 在最后一个插件中使用
    vitePluginDeployOss({
      // 建议按环境变量开关上传，避免本地/CI误上传
      open: process.env.DEPLOY_OSS === '1',
      // 终端实时动效进度面板（默认 true）
      fancy: true,

      accessKeyId: '***',
      accessKeySecret: '***',
      bucket: '***',
      region: '***',
      uploadDir: `H5/zz/test`,
      skip: ['**/index.html'],

      // 默认 true：有上传失败时抛错并让构建失败
      failOnError: true,

      // 修改打包后的资源路径
      configBase: `https://oss.eventnet.cn/H5/zz/test/`,
    }),
  ],
}
```

## 说明

- 当前版本仅支持 ESM（`import`），不再提供 CommonJS（`require`）入口。
- `open` 默认 `true`，建议通过环境变量控制开关（例如 `DEPLOY_OSS=1` 时再上传）。
- `fancy` 默认 `true`，TTY 终端下会显示实时动效进度（速度、预计剩余、并发、当前文件）。
- `failOnError` 默认 `true`，上传有失败会抛错，适合 CI 场景保证发布质量。
