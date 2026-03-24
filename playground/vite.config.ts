import { defineConfig } from 'vite'
import vitePluginDeployOss from '../src'

export default defineConfig(({ mode }) => {
  const shouldDeploy = mode === 'deploy' || mode === 'deploy-debug' || process.env.DEPLOY_OSS === '1'
  const isDebug = mode === 'debug' || mode === 'deploy-debug' || process.env.DEPLOY_OSS_DEBUG === '1'

  return {
    plugins: [
      vitePluginDeployOss({
        open: shouldDeploy,
        debug: isDebug,

        accessKeyId: process.env.zAccessKeyId || '',
        accessKeySecret: process.env.zAccessKeySecret || '',
        bucket: process.env.zBucket || '',
        region: 'oss-cn-beijing',
        alias: process.env.zBucketAlias || '',
        uploadDir: `/test/__test/`,
        skip: ['**/*.html', '**/pluginWebUpdateNotice/**'],
        overwrite: true,
        autoDelete: false,
        manifest: true,

        // 修改打包后的资源路径
        configBase: `${process.env.zBucketAlias || ''}/test/__test/`,
      }),
    ],

    build: {
      outDir: '__dist__',
      rollupOptions: {
        input: {
          main: './index.html',
        },
      },
    },
  }
})
