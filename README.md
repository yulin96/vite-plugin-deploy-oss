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
      accessKeyId: '***',
      accessKeySecret: '***',
      bucket: '***',
      region: '***',
      uploadDir: `H5/zz/test`,
      skip: ['**/index.html'],
      // 修改打包后的资源路径
      configBase: `https://oss.eventnet.cn/H5/zz/test/`,
    }),
  ],
}
```
