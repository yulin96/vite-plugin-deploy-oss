# vite-plugin-deploy-oss

[![npm version](https://img.shields.io/npm/v/vite-plugin-deploy-oss.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-deploy-oss)
[![npm downloads](https://img.shields.io/npm/dm/vite-plugin-deploy-oss.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-deploy-oss)
[![npm license](https://img.shields.io/npm/l/vite-plugin-deploy-oss.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-deploy-oss)

Upload Vite build artifacts to Aliyun OSS.
[![npm version](https://img.shields.io/npm/v/vite-plugin-deploy-oss.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-deploy-oss)
[![npm downloads](https://img.shields.io/npm/dm/vite-plugin-deploy-oss.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-deploy-oss)
[![npm license](https://img.shields.io/npm/l/vite-plugin-deploy-oss.svg?style=flat-square)](https://www.npmjs.com/package/vite-plugin-deploy-oss)

Upload Vite build artifacts to Aliyun OSS.

## Installation

## Installation

```bash
pnpm add vite-plugin-deploy-oss -D
```

## Quick Start

## Quick Start

It is recommended to control the deployment using environment variables to avoid accidental uploads during local builds.
It is recommended to control the deployment using environment variables to avoid accidental uploads during local builds.

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

Run build and deploy:
Run build and deploy:

```bash
DEPLOY_OSS=1 pnpm build
```

## Configuration

## Configuration

| Option            | Default           | Description                                                                  |
| :---------------- | :---------------- | :--------------------------------------------------------------------------- |
| `open`            | `true`            | Whether to enable upload. Recommended to control with environment variables. |
| `accessKeyId`     | -                 | OSS access key ID.                                                           |
| `accessKeySecret` | -                 | OSS access key secret.                                                       |
| `bucket`          | -                 | OSS bucket name.                                                             |
| `region`          | -                 | OSS region, e.g., `oss-cn-beijing`.                                          |
| `uploadDir`       | -                 | Target directory in OSS to upload files.                                     |
| `configBase`      | -                 | Modifies Vite's asset base path synchronously.                               |
| `skip`            | `'**/index.html'` | Glob pattern for files to skip uploading.                                    |
| `overwrite`       | `true`            | Whether to overwrite existing files on OSS with the same name.               |
| `autoDelete`      | `false`           | Whether to delete local build files after successful upload.                 |
| `manifest`        | `false`           | Whether to generate and upload a build manifest file.                        |
| `failOnError`     | `true`            | Whether to abort the build process if upload fails.                          |
| `debug`           | `false`           | Whether to output time cost information for debugging.                       |
| `fancy`           | `true`            | Whether to display a styled terminal progress bar.                           |

## Important Behaviors

- If `open: true` and any of the required options (`accessKeyId`, `accessKeySecret`, `bucket`, `region`, or `uploadDir`) are missing, the build process will fail and terminate.
- When `manifest` is enabled, all built files are uploaded automatically, and local build files are retained.
- When `manifest` is enabled, `skip` defaults to an empty array and `autoDelete` is forced to `false`.
- `oss-manifest.json` only tracks successfully uploaded files in the current build and does not include the manifest file itself.
- `configBase` affects both Vite's output asset paths and the URL addresses inside the manifest.
- `alias` only affects the URLs generated inside the manifest; it does not change the actual upload destination on OSS.

## Important Behaviors

- If `open: true` and any of the required options (`accessKeyId`, `accessKeySecret`, `bucket`, `region`, or `uploadDir`) are missing, the build process will fail and terminate.
- When `manifest` is enabled, all built files are uploaded automatically, and local build files are retained.
- When `manifest` is enabled, `skip` defaults to an empty array and `autoDelete` is forced to `false`.
- `oss-manifest.json` only tracks successfully uploaded files in the current build and does not include the manifest file itself.
- `configBase` affects both Vite's output asset paths and the URL addresses inside the manifest.
- `alias` only affects the URLs generated inside the manifest; it does not change the actual upload destination on OSS.

## Manifest

Enable manifest:
Enable manifest:

```ts
vitePluginDeployOss({
  // ...other options
  // ...other options
  manifest: true,
})
```

Customize manifest filename:
Customize manifest filename:

```ts
vitePluginDeployOss({
  // ...other options
  // ...other options
  manifest: {
    fileName: 'meta/oss-manifest.json',
  },
})
```

Manifest JSON example:
Manifest JSON example:

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

## Debugging

## Debugging

Enable `debug` to log the time taken for each key step during deployment, which helps locate bottlenecks:
Enable `debug` to log the time taken for each key step during deployment, which helps locate bottlenecks:

```ts
vitePluginDeployOss({
  // ...other options
  // ...other options
  debug: process.env.DEPLOY_OSS_DEBUG === '1',
})
```

You can also run the playground command in the project:
You can also run the playground command in the project:

```bash
pnpm run build:test:debug
```

## Notes

## Notes

- It is highly recommended to use environment variables instead of hardcoding sensitive credentials.
- Keep `failOnError: true` for production builds to avoid completing the build/deployment pipeline when some files failed to upload.
- Make sure you do not need the local build directory before enabling `autoDelete`.
- The current version only supports ESM (`import` syntax). CommonJS (`require`) is not supported.
- It is highly recommended to use environment variables instead of hardcoding sensitive credentials.
- Keep `failOnError: true` for production builds to avoid completing the build/deployment pipeline when some files failed to upload.
- Make sure you do not need the local build directory before enabling `autoDelete`.
- The current version only supports ESM (`import` syntax). CommonJS (`require`) is not supported.
