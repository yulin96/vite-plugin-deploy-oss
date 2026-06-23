import { defineDeployConfig } from '../dist/index.js'

export default defineDeployConfig({
  accessKeyId: process.env.zAccessKeyId || '',
  accessKeySecret: process.env.zAccessKeySecret || '',
  bucket: process.env.zBucket || '',
  region: 'oss-cn-beijing',
  alias: process.env.zBucketAlias || '',

  outDir: 'playground/__dist__',
  uploadDir: '/test/__direct-cli__/',
  skip: ['**/*.html', '**/pluginWebUpdateNotice/**'],
  overwrite: true,
  autoDelete: false,
  manifest: true,
  configBase: `${process.env.zBucketAlias || ''}/test/__direct-cli__/`,
})
