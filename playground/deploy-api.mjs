import { deployOss } from '../dist/deploy.js'

await deployOss({
  accessKeyId: process.env.zAccessKeyId || '',
  accessKeySecret: process.env.zAccessKeySecret || '',
  bucket: process.env.zBucket || '',
  region: 'oss-cn-beijing',
  alias: process.env.zBucketAlias || '',

  outDir: 'playground/__dist__',
  uploadDir: '/test/__direct-api__/',
  skip: ['**/*.html', '**/pluginWebUpdateNotice/**'],
  overwrite: true,
  autoDelete: false,
  manifest: true,
  configBase: `${process.env.zBucketAlias || ''}/test/__direct-api__/`,
})
