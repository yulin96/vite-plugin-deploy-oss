# vite-plugin-deploy-oss

把 Vite 打包后的文件上传到阿里云 OSS。

## 安装

```bash
pnpm add vite-plugin-deploy-oss -D
```

## 快速开始

推荐用环境变量控制上传，避免本地随手打包时误上传。

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vitePluginDeployOss from 'vite-plugin-deploy-oss'

export default defineConfig({
  plugins: [
    vitePluginDeployOss({
      open: process.env.DEPLOY_OSS === '1',

      accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
      bucket: process.env.OSS_BUCKET || '',
      region: process.env.OSS_REGION || '',

      uploadDir: 'H5/demo/prod',
      configBase: 'https://example.com/H5/demo/prod/',

      manifest: true,
      failOnError: true,
    }),
  ],
})
```

发布时执行：

```bash
DEPLOY_OSS=1 pnpm build
```

## 常用配置

| 配置              | 默认值            | 说明                               |
| ----------------- | ----------------- | ---------------------------------- |
| `open`            | `true`            | 是否开启上传。建议用环境变量控制。 |
| `accessKeyId`     | -                 | OSS 访问密钥。                     |
| `accessKeySecret` | -                 | OSS 访问密钥。                     |
| `bucket`          | -                 | OSS bucket 名称。                  |
| `region`          | -                 | OSS 区域，例如 `oss-cn-beijing`。  |
| `uploadDir`       | -                 | 文件上传到 OSS 的目标目录。        |
| `configBase`      | -                 | 同步修改 Vite 的资源访问路径。     |
| `skip`            | `'**/index.html'` | 不上传的文件规则。                 |
| `overwrite`       | `true`            | 是否允许覆盖远端同名文件。         |
| `autoDelete`      | `false`           | 上传成功后是否删除本地构建文件。   |
| `manifest`        | `false`           | 是否生成并上传文件清单。           |
| `failOnError`     | `true`            | 上传失败时是否中断构建。           |
| `debug`           | `false`           | 是否输出耗时信息。                 |
| `fancy`           | `true`            | 是否显示更友好的终端进度。         |

## 重要行为

- `open: true` 时，如果缺少 `accessKeyId`、`accessKeySecret`、`bucket`、`region` 或 `uploadDir`，会直接中断构建。
- `manifest` 开启后，会自动上传全部文件，并自动保留本地构建文件。
- `manifest` 开启后，`skip` 会按空数组处理，`autoDelete` 会按 `false` 处理。
- `oss-manifest.json` 只记录本次成功上传的文件，不包含清单文件自身。
- `configBase` 会影响 Vite 打包后的资源路径，也会影响清单里的访问地址。
- `alias` 只影响清单里生成的访问地址，不会改变实际上传路径。

## Manifest

开启：

```ts
vitePluginDeployOss({
  // ...其他配置
  manifest: true,
})
```

自定义文件名：

```ts
vitePluginDeployOss({
  // ...其他配置
  manifest: {
    fileName: 'meta/oss-manifest.json',
  },
})
```

清单内容示例：

```json
{
  "version": 1742467200000,
  "files": [
    {
      "file": "assets/index-abc123.js",
      "key": "H5/demo/prod/assets/index-abc123.js",
      "url": "https://example.com/H5/demo/prod/assets/index-abc123.js",
      "md5": "d41d8cd98f00b204e9800998ecf8427e"
    }
  ]
}
```

## 调试

开启 `debug` 后，构建结束会额外输出关键步骤耗时，方便判断慢在哪里。

```ts
vitePluginDeployOss({
  // ...其他配置
  debug: process.env.DEPLOY_OSS_DEBUG === '1',
})
```

也可以使用项目内的 playground 命令：

```bash
pnpm run build:test:debug
```

## 注意事项

- 建议不要在配置里直接写真实密钥，优先使用环境变量。
- 建议生产发布时保持 `failOnError: true`，避免部分文件没上传却继续完成流程。
- 如果开启 `autoDelete`，请确认不需要保留本地构建文件。
- 当前版本仅支持 ESM，也就是 `import` 用法，不提供 `require` 入口。
