import { defineConfig } from 'vite'
import vitePluginDeployOss from './src'

export default defineConfig({
  plugins: [
    vitePluginDeployOss({
      open: true,

      accessKeyId: process.env.zAccessKeyId || '',
      accessKeySecret: process.env.zAccessKeySecret || '',
      bucket: process.env.zBucket || '',
      region: 'oss-cn-beijing',
      alias: process.env.zBucketAlias || '',
      uploadDir: `/test/__test/`,
      skip: ['**/*.html', '**/pluginWebUpdateNotice/**'],
      overwrite: true,
      autoDelete: false,

      // 修改打包后的资源路径
      configBase: `${process.env.zBucketAlias || ''}/test/__test/`,
    }),
  ],

  build: {
    outDir: '__dist__',
  },
})
